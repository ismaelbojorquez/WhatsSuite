import EventEmitter from 'node:events';
import logger from '../infra/logging/logger.js';
import { AppError } from '../shared/errors.js';
import { planWarmupGroups } from './warmupBlenderService.js';
import { generateHumanConversation } from './warmupConversationGenerator.js';
import { computeHumanDelay, buildTimingConfig } from './humanTimingService.js';
import { sendWhatsAppMessage, getStatusForSession } from './whatsappService.js';
import { resolveProfile } from './warmupProfiles.js';
import {
  recordWarmupSent,
  recordWarmupFailed,
  recordWarmupSkip,
  auditWarmup,
  buildAlertPayload
} from './warmupTelemetry.js';
import { registerWarmupMessage } from './warmupMessageRegistry.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeParticipant = (p) => {
  const id = p?.id || p?.sessionName || p?.phone || p;
  return {
    ...p,
    id,
    sessionName: p.sessionName || p.id || p.phone,
    phone: p.phone || p.number || null,
    tenantId: p.tenantId || null
  };
};

export class WarmupEngine extends EventEmitter {
  constructor({
    allowSend = false, // default dry-run to avoid touching real traffic
    timingConfig = buildTimingConfig(),
    retryDelaysMs = [3000, 7000],
    simulate = false, // when true, do not wait or send; only return plan
    emojiChance = 0.25,
    typoChance = 0.08,
    maxMessagesPerRun = 120,
    maxPerSessionPerRun = 40,
    failShutdownThreshold = 5,
    autoShutdown = true,
    allowedConnectionStatuses = (process.env.WARMUP_ALLOWED_STATUSES || 'active,connected')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    log = logger
  } = {}) {
    super();
    this.allowSend = allowSend;
    this.timingConfig = timingConfig;
    this.retryDelaysMs = retryDelaysMs;
    this.simulate = simulate;
    this.emojiChance = emojiChance;
    this.typoChance = typoChance;
    this.maxMessagesPerRun = maxMessagesPerRun;
    this.maxPerSessionPerRun = maxPerSessionPerRun;
    this.failShutdownThreshold = failShutdownThreshold;
    this.autoShutdown = autoShutdown;
    this.disabled = false;
    this.consecutiveFailures = 0;
    this.allowedConnectionStatuses = allowedConnectionStatuses;
    this.log = log;
  }

  async ensureSessionConnected(sessionName, tenantId = null) {
    try {
      const status = await getStatusForSession(sessionName, { tenantId });
      const normalized = (status?.status || '').toLowerCase();
      const connected = this.allowedConnectionStatuses.includes(normalized);
      if (!connected) {
        const payload = { sessionName, status };
        this.emit('session_skipped', payload);
        await auditWarmup({ action: 'warmup_session_skipped', resourceId: sessionName, metadata: payload, tenantId });
      }
      return connected;
    } catch (err) {
      this.log.warn({ err, sessionName, tag: 'WARMUP_SESSION_STATUS' }, 'Failed to check session status');
      return false;
    }
  }

  async sendWithRetry({ from, to, text, meta, profile }) {
    if (this.disabled) {
      throw new AppError('WarmupEngine disabled', 503);
    }
    const payload = { sessionName: from.sessionName, remoteNumber: to.phone, content: text };
    const attempts = this.retryDelaysMs.length + 1;
    for (let i = 0; i < attempts; i += 1) {
      try {
        if (!this.allowSend) {
          const evt = { from: from.sessionName, to: to.phone, text, meta, profile };
          this.emit('dry_run', evt);
          await recordWarmupSent({
            lineId: from.id,
            sessionName: from.sessionName,
            to: to.phone,
            delayMs: meta?.delayMs || null,
            topic: meta?.topic || null,
            profile: profile?.key || null,
            dryRun: true,
            text
          });
          return { messageId: null, dryRun: true };
        }
        await registerWarmupMessage({
          from,
          to,
          text,
          meta,
          profile,
          phase: 'pending'
        });
        const res = await sendWhatsAppMessage(payload);
        try {
          await registerWarmupMessage({
            from,
            to,
            messageId: res.messageId,
            text,
            meta,
            profile,
            phase: 'sent'
          });
        } catch (registryErr) {
          this.log.warn(
            {
              err: registryErr,
              from: from.sessionName,
              to: to.phone,
              messageId: res.messageId,
              tag: 'WARMUP_MESSAGE_REGISTRY'
            },
            'Warmup message sent but final registry update failed'
          );
        }
        const evt = { from: from.sessionName, to: to.phone, text, meta, messageId: res.messageId, profile };
        this.emit('sent', evt);
        await recordWarmupSent({
          lineId: from.id,
          sessionName: from.sessionName,
          to: to.phone,
          delayMs: meta?.delayMs || null,
          topic: meta?.topic || null,
          profile: profile?.key || null,
          dryRun: false,
          messageId: res.messageId,
          text
        });
        this.consecutiveFailures = 0;
        return res;
      } catch (err) {
        const retriable = !(err instanceof AppError) || (err?.statusCode || 500) >= 500;
        this.log.warn(
          { err, attempt: i + 1, from: from.sessionName, to: to.phone, tag: 'WARMUP_SEND', profile: profile?.key },
          'Warmup send failed'
        );
        if (!retriable || i === attempts - 1) {
          const evt = { from: from.sessionName, to: to.phone, text, meta, err, profile };
          this.emit('failed', evt);
          await recordWarmupFailed({
            lineId: from.id,
            sessionName: from.sessionName,
            to: to.phone,
            error: err,
            profile: profile?.key || null,
            text
          });
          const alert = buildAlertPayload({
            lineId: from.id,
            sessionName: from.sessionName,
            reason: 'warmup_send_failed',
            context: { to: to.phone, error: err?.message || String(err), attempt: i + 1 }
          });
          this.log.error({ alert, tag: 'WARMUP_ALERT' }, 'Warmup send failed - alert');
          await auditWarmup({
            action: 'warmup_send_failed',
            resourceId: from.sessionName,
            metadata: { to: to.phone, error: err?.message || String(err), profile: profile?.key || null }
          });
          this.consecutiveFailures += 1;
          if (this.autoShutdown && this.consecutiveFailures >= this.failShutdownThreshold) {
            this.disabled = true;
            this.emit('shutdown', { reason: 'fail_threshold', failures: this.consecutiveFailures });
            this.log.error(
              { failures: this.consecutiveFailures, tag: 'WARMUP_AUTO_SHUTDOWN' },
              'WarmupEngine auto-shutdown triggered by failures'
            );
          }
          throw err;
        }
        const backoff = this.retryDelaysMs[i] || this.retryDelaysMs[this.retryDelaysMs.length - 1];
        await sleep(backoff);
      }
    }
    return null;
  }

  async runConversation({ group, topicKey = null, turns = 8, profiles = {}, simulate = false }) {
    const participants = group.map(normalizeParticipant).filter((p) => p.id && p.sessionName && p.phone);
    if (participants.length < 2) {
      throw new AppError('Se requieren al menos 2 participantes con sessionName y phone', 400);
    }
    if (this.disabled) {
      this.log.warn({ tag: 'WARMUP_DISABLED' }, 'WarmupEngine disabled - skipping conversation');
      return [];
    }
    this.log.info(
      { groupSize: participants.length, topicKey, turns, tag: 'WARMUP_CONVO_START' },
      'Starting warmup conversation'
    );

    const profileFor = (line) => resolveProfile(profiles[line.id] || line.profile || line.warmupProfile || null);
    const participantProfiles = participants.map((p) => profileFor(p));
    const groupTurns = Math.min(
      ...participantProfiles.map((prof) => prof?.turnsPerConversation || turns),
      turns || 8
    );

    const mergedTiming = participantProfiles.reduce((acc, prof) => {
      const t = prof?.timingOverrides || {};
      return {
        ...acc,
        baseDelaySeconds: [
          Math.max(acc.baseDelaySeconds?.[0] || 0, t.baseDelaySeconds?.[0] || acc.baseDelaySeconds?.[0] || 0),
          Math.max(acc.baseDelaySeconds?.[1] || 0, t.baseDelaySeconds?.[1] || acc.baseDelaySeconds?.[1] || 0)
        ],
        longPauseSeconds: [
          Math.max(acc.longPauseSeconds?.[0] || 0, t.longPauseSeconds?.[0] || acc.longPauseSeconds?.[0] || 0),
          Math.max(acc.longPauseSeconds?.[1] || 0, t.longPauseSeconds?.[1] || acc.longPauseSeconds?.[1] || 0)
        ],
        longPauseChance: Math.max(acc.longPauseChance || 0, t.longPauseChance || acc.longPauseChance || 0),
        jitterSeconds: t.jitterSeconds || acc.jitterSeconds,
        typingCharsPerSec: t.typingCharsPerSec || acc.typingCharsPerSec,
        typingMinMs: t.typingMinMs || acc.typingMinMs,
        activeHours: t.activeHours || acc.activeHours,
        nightResumeJitterSeconds: t.nightResumeJitterSeconds || acc.nightResumeJitterSeconds
      };
    }, { ...this.timingConfig });

    const emojiChance =
      Math.min(...participantProfiles.map((prof) => prof?.emojiChance || this.emojiChance || 0.25), 0.6) || 0.25;
    const typoChance = Math.min(
      ...participantProfiles.map((prof) => prof?.typoChance || this.typoChance || 0.08),
      0.2
    );
    const longBias =
      Math.min(...participantProfiles.map((prof) => prof?.longBias || 0.45), 0.7) || 0.45;

    const ready = await Promise.all(
      participants.map(async (p) => this.ensureSessionConnected(p.sessionName, p.tenantId))
    );
    if (ready.some((ok) => !ok)) {
      const payload = { reason: 'session_not_connected', group: participants };
      this.emit('skipped', payload);
      for (const p of participants) {
        await recordWarmupSkip({ lineId: p.id, sessionName: p.sessionName, reason: 'session_not_connected', profile: profileFor(p).key });
      }
      return [];
    }

    const convo = generateHumanConversation({ participants, topicKey, turns: groupTurns, emojiChance, typoChance, longBias });
    const delivered = [];
    const planned = [];
    const perSessionCounter = new Map();
    let totalMessages = 0;

    for (const msg of convo.messages) {
      if (this.maxMessagesPerRun && totalMessages >= this.maxMessagesPerRun) {
        this.log.warn({ tag: 'WARMUP_LIMIT', reason: 'maxMessagesPerRun' }, 'Warmup loop stopped by max message cap');
        break;
      }
      const from = participants.find((p) => p.id === msg.from);
      const to = participants.find((p) => p.id === msg.to) || participants.find((p) => p.id !== msg.from);
      if (!from || !to) continue;
      const sentCount = perSessionCounter.get(from.sessionName) || 0;
      if (this.maxPerSessionPerRun && sentCount >= this.maxPerSessionPerRun) {
        this.log.warn(
          { sessionName: from.sessionName, tag: 'WARMUP_SESSION_LIMIT' },
          'Warmup session cap reached in this run'
        );
        continue;
      }

      const timing = computeHumanDelay({
        text: msg.text,
        isLong: msg.meta?.isLong,
        config: mergedTiming
      });
      const sendMeta = { ...msg.meta, delayMs: timing.delayMs, topic: convo.topic };

      const planEntry = {
        from: from.sessionName,
        to: to.phone,
        text: msg.text,
        meta: sendMeta,
        delayMs: timing.delayMs,
        typingMs: timing.typingMs,
        profile: profileFor(from).key
      };
      planned.push(planEntry);
      totalMessages += 1;
      perSessionCounter.set(from.sessionName, sentCount + 1);

      if (simulate || this.simulate) {
        this.emit('simulation', { ...planEntry, topic: convo.topic });
        continue;
      }

      this.emit('typing', { from: from.sessionName, to: to.phone, typingMs: timing.typingMs, meta: msg.meta, profile: profileFor(from).key });
      await sleep(timing.delayMs);

      const res = await this.sendWithRetry({ from, to, text: msg.text, meta: sendMeta, profile: profileFor(from) });
      delivered.push({
        ...res,
        ...planEntry
      });
    }

    if (simulate || this.simulate) {
      this.log.info(
        { groupSize: participants.length, messages: planned.length, tag: 'WARMUP_SIMULATION' },
        'Warmup simulation plan (no messages sent)'
      );
      return planned.map((p) => ({ ...p, simulated: true }));
    }

    return delivered;
  }

  async runGroups({ lines, topicKey = null, turns = 8, blenderOptions = {}, profiles = {}, simulate = false }) {
    if (this.disabled) {
      this.log.warn({ tag: 'WARMUP_DISABLED' }, 'WarmupEngine disabled - skipping runGroups');
      return [];
    }
    const groups = await planWarmupGroups(lines, blenderOptions);
    const results = [];
    for (const group of groups) {
      const convoResult = await this.runConversation({ group, topicKey, turns, profiles, simulate });
      results.push({ group: group.map(normalizeParticipant), delivered: convoResult, simulated: simulate || this.simulate });
    }
    return results;
  }
}

export const createWarmupEngine = (options = {}) => new WarmupEngine(options);

// Ejemplo de uso de envio de mensajes de warmup sin afectar trafico real (allowSend: false default):
export const exampleWarmupSend = async () => {
  const engine = new WarmupEngine({ allowSend: false, simulate: true });
  const lines = [
    { id: 'lineA', sessionName: 'wa-sess-a', phone: '5491112340000' },
    { id: 'lineB', sessionName: 'wa-sess-b', phone: '5491112340001' },
    { id: 'lineC', sessionName: 'wa-sess-c', phone: '5491112340002' }
  ];
  engine.on('simulation', (evt) => logger.info({ evt, tag: 'WARMUP_SIM_EXAMPLE' }, 'Warmup simulated message'));
  engine.on('sent', (evt) => logger.info({ evt, tag: 'WARMUP_EXAMPLE' }, 'Warmup message sent'));
  return engine.runGroups({ lines, turns: 6, topicKey: 'catchup' });
};

export default createWarmupEngine;
