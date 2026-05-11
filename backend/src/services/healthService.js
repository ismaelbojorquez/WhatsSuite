import { healthCheck as dbHealthCheck } from '../infra/db/postgres.js';
import { redisHealthCheck } from '../infra/cache/redisClient.js';
import env from '../config/env.js';
import { getStartupState } from '../infra/runtime/startupState.js';

// Aggregates infra checks so readiness reflects downstream guarantees.
const getReadiness = async () => {
  const [db, cache] = await Promise.allSettled([dbHealthCheck(), redisHealthCheck()]);
  const startup = getStartupState();

  const dependencies = {
    postgres: db.status === 'fulfilled' ? db.value : { healthy: false, error: db.reason?.message },
    redis: cache.status === 'fulfilled' ? cache.value : { healthy: false, error: cache.reason?.message }
  };

  const healthy = startup.ready && Object.values(dependencies).every((dep) => dep.healthy);

  return {
    service: env.serviceName,
    instance: env.instanceId,
    healthy,
    timestamp: new Date().toISOString(),
    startup,
    dependencies
  };
};

const getLiveness = () => ({
  service: env.serviceName,
  instance: env.instanceId,
  healthy: true,
  timestamp: new Date().toISOString(),
  startup: getStartupState()
});

export default { getReadiness, getLiveness };
