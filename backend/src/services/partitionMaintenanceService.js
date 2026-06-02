import env from '../config/env.js';
import pool from '../infra/db/postgres.js';
import logger from '../infra/logging/logger.js';

let maintenanceTimer = null;
let running = false;

export const runPartitionMaintenance = async () => {
  if (running) return;
  running = true;
  try {
    await pool.query('SELECT ensure_database_partitions($1::integer, $2::integer)', [
      env.maintenance.partitionMonthsBack,
      env.maintenance.partitionMonthsAhead
    ]);
    logger.info(
      {
        monthsBack: env.maintenance.partitionMonthsBack,
        monthsAhead: env.maintenance.partitionMonthsAhead,
        tag: 'PARTITION_MAINTENANCE'
      },
      'Database partitions ensured'
    );
  } catch (err) {
    logger.error({ err, tag: 'PARTITION_MAINTENANCE' }, 'Database partition maintenance failed');
    throw err;
  } finally {
    running = false;
  }
};

export const startPartitionMaintenance = () => {
  if (maintenanceTimer) return maintenanceTimer;
  const intervalMs = Math.max(1, env.maintenance.partitionIntervalHours) * 60 * 60 * 1000;

  runPartitionMaintenance().catch(() => {});
  maintenanceTimer = setInterval(() => {
    runPartitionMaintenance().catch(() => {});
  }, intervalMs);

  if (typeof maintenanceTimer.unref === 'function') {
    maintenanceTimer.unref();
  }

  logger.info(
    {
      intervalHours: env.maintenance.partitionIntervalHours,
      monthsAhead: env.maintenance.partitionMonthsAhead,
      tag: 'PARTITION_MAINTENANCE'
    },
    'Database partition maintenance scheduler started'
  );
  return maintenanceTimer;
};

export const stopPartitionMaintenance = () => {
  if (!maintenanceTimer) return;
  clearInterval(maintenanceTimer);
  maintenanceTimer = null;
};
