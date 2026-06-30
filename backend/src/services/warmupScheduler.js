import EventEmitter from 'node:events';
import logger from '../infra/logging/logger.js';
import { ensureRedisConnection } from '../infra/cache/redisClient.js';
import redisClient from '../infra/cache/redisClient.js';
import { createWorkerQueue } from '../infra/queues/workerQueue.js';
import { createWarmupEngine } from './warmupEngine.js';
import { resolveProfile } from './warmupProfiles.js';
import { recordWarmupSkip } from './warmupTelemetry.js';

const toMidnightTtlSeconds = () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
};

const dailyQuotaKey = (lineId) => {
  const now = new Date();
  const day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate()
  ).padStart(2, '0')}`;
  return `warmup:quota:${lineId}:${day}`;
};

const lastRunKey = (lineId) => `warmup:last-run:${lineId}`;

const normalizeLines = (lines = []) =>
  (lines || []).map((l) => ({
    ...l,
    id: l?.id || l?.sessionName || l?.phone,
    status: l?.status || 'active'
  }));

export class WarmupScheduler extends EventEmitter {
  constructor({
    name = 'warmup-scheduler',
    engine = createWarmupEngine({ allowSend: false }),
    fetchLines = async () => [],
    frequencyMs = 60_000,
    concurrency = 1,
    dailyLimitPerLine = 30,
    allowedStatuses = (process.env.WARMUP_ALLOWED_STATUSES || 'active,connected')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    loggerInstance = logger
  } = {}) {
    super();
    this.name = name;
    this.engine = engine;
    this.fetchLines = fetchLines;
    this.frequencyMs = frequencyMs;
    this.dailyLimitPerLine = dailyLimitPerLine;
    this.allowedStatuses = allowedStatuses;
    this.logger = loggerInstance;
    this.timer = null;
    this.paused = false;
    this.running = false;
    this.queue = createWorkerQueue({ concurrency, maxQueue: concurrency * 2, name, logger: this.logger });
  }

  ensureTimer() {
    if (!this.timer) {
      this.timer = setInterval(() => this.scheduleCycle(), this.frequencyMs);
    }
  }

  start() {
    this.paused = false;
    this.ensureTimer();
    this.paused = false;
    this.logger.info({ scheduler: this.name, frequencyMs: this.frequencyMs }, 'Warmup scheduler started');
    this.emit('started', { name: this.name });
    this.scheduleCycle();
  }

  pause() {
    this.paused = true;
    this.emit('paused', { name: this.name });
    this.logger.info({ scheduler: this.name }, 'Warmup scheduler paused');
  }

  resume() {
    this.paused = false;
    this.ensureTimer();
    this.emit('resumed', { name: this.name });
    this.logger.info({ scheduler: this.name }, 'Warmup scheduler resumed');
    this.scheduleCycle();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('stopped', { name: this.name });
    this.logger.info({ scheduler: this.name }, 'Warmup scheduler stopped');
  }

  async scheduleCycle() {
    if (this.paused) return;
    try {
      await this.queue.enqueue(() => this.runCycle());
    } catch (err) {
      this.logger.warn({ err, scheduler: this.name }, 'Warmup cycle enqueue failed');
    }
  }

  async getQuota(lineId) {
    await ensureRedisConnection();
    const key = dailyQuotaKey(lineId);
    const raw = await redisClient.get(key);
    return Number.parseInt(raw || '0', 10);
  }

  async incrementQuota(lineId, delta = 1) {
    await ensureRedisConnection();
    const key = dailyQuotaKey(lineId);
    const ttl = toMidnightTtlSeconds();
    const tx = redisClient.multi();
    tx.incrBy(key, delta);
    tx.expire(key, ttl, 'NX');
    await tx.exec();
  }

  async getLastRun(lineId) {
    await ensureRedisConnection();
    const raw = await redisClient.get(lastRunKey(lineId));
    return raw ? Number.parseInt(raw, 10) : null;
  }

  async setLastRun(lineId, ts = Date.now()) {
    await ensureRedisConnection();
    await redisClient.set(lastRunKey(lineId), String(ts), { EX: 7 * 24 * 3600 });
  }

  async filterEligible(lines) {
    const normalized = normalizeLines(lines).filter((l) => l.id);
    const result = [];
    for (const line of normalized) {
      const profile = resolveProfile(line?.warmupProfile || line?.profile || null);
      if (!this.allowedStatuses.includes((line.status || '').toLowerCase())) {
        this.emit('line_skipped', { line, reason: 'status', profile: profile.key });
        await recordWarmupSkip({ lineId: line.id, sessionName: line.sessionName, reason: 'status', profile: profile.key });
        continue;
      }
      const used = await this.getQuota(line.id);
      const limit = profile?.dailyLimit || this.dailyLimitPerLine;
      if (used >= limit) {
        this.emit('line_skipped', { line, reason: 'quota', profile: profile.key });
        await recordWarmupSkip({ lineId: line.id, sessionName: line.sessionName, reason: 'quota', profile: profile.key });
        continue;
      }
      const lastRunTs = await this.getLastRun(line.id);
      if (lastRunTs) {
        const elapsed = Date.now() - lastRunTs;
        if (elapsed < (profile?.minIntervalMs || 0)) {
          this.emit('line_skipped', { line, reason: 'min_interval', profile: profile.key });
          await recordWarmupSkip({
            lineId: line.id,
            sessionName: line.sessionName,
            reason: 'min_interval',
            profile: profile.key
          });
          continue;
        }
      }
      result.push({ ...line, warmupProfile: profile.key });
    }
    return result;
  }

  async runCycle() {
    if (this.running) {
      this.logger.debug({ scheduler: this.name }, 'Warmup cycle skipped (already running)');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const allLines = await this.fetchLines();
      const eligible = await this.filterEligible(allLines);
      if (!eligible.length) {
        this.logger.info({ scheduler: this.name }, 'No eligible lines for warmup');
        return;
      }
      this.logger.info(
        { scheduler: this.name, eligible: eligible.length, total: allLines?.length || 0 },
        'Starting warmup cycle'
      );
      const profileMap = Object.fromEntries(
        eligible.map((l) => [l.id, resolveProfile(l?.warmupProfile || l?.profile || null)])
      );
      const results = await this.engine.runGroups({ lines: eligible, profiles: profileMap, simulate: this.engine.simulate });
      // Count sends per line to update quota
      for (const groupResult of results) {
        for (const msg of groupResult.delivered || []) {
          const line = (groupResult.group || []).find(
            (l) => l.sessionName === msg.from || l.id === msg.from || l.phone === msg.from
          );
          const lineId = line?.id || msg.from;
          if (lineId) {
            await this.incrementQuota(lineId, 1);
          }
        }
        for (const line of groupResult.group || []) {
          if (line?.id) {
            await this.setLastRun(line.id, Date.now());
          }
        }
      }
      this.emit('cycle_complete', {
        scheduler: this.name,
        durationMs: Date.now() - startedAt,
        groups: results.length
      });
      this.logger.info(
        { scheduler: this.name, durationMs: Date.now() - startedAt, groups: results.length },
        'Warmup cycle complete'
      );
    } catch (err) {
      this.logger.error({ err, scheduler: this.name }, 'Warmup cycle failed');
      this.emit('cycle_failed', { scheduler: this.name, err });
    } finally {
      this.running = false;
    }
  }
}

export const createWarmupScheduler = (options = {}) => new WarmupScheduler(options);

// Ejemplo minimo: arranque manual (modo dry-run por defecto)
export const exampleWarmupScheduler = () => {
  const scheduler = createWarmupScheduler({
    name: 'warmup-dryrun',
    fetchLines: async () => [
      { id: 'lineA', sessionName: 'wa-sess-a', phone: '5491112340000', status: 'active' },
      { id: 'lineB', sessionName: 'wa-sess-b', phone: '5491112340001', status: 'active' },
      { id: 'lineC', sessionName: 'wa-sess-c', phone: '5491112340002', status: 'active' }
    ],
    frequencyMs: 120_000,
    dailyLimitPerLine: 10
  });
  scheduler.start();
  return scheduler;
};

export default createWarmupScheduler;
