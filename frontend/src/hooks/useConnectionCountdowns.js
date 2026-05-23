import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotify } from '../context/NotifyContext.jsx';
import { dispatchLocalNotification } from '../lib/localNotifications.js';

const STORAGE_KEY = 'whatssuite.connectionCountdowns.v1';

const canUseStorage = () => typeof window !== 'undefined' && Boolean(window.localStorage);

const normalizeStoredCountdowns = (value) => {
  if (!value || typeof value !== 'object') return {};

  return Object.entries(value).reduce((acc, [sessionId, countdown]) => {
    const endsAt = Number(typeof countdown === 'number' ? countdown : countdown?.endsAt);
    if (!sessionId || !Number.isFinite(endsAt)) return acc;
    acc[sessionId] = {
      sessionId,
      endsAt,
      startedAt: Number(countdown?.startedAt) || null
    };
    return acc;
  }, {});
};

const readStoredCountdowns = () => {
  if (!canUseStorage()) return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeStoredCountdowns(raw ? JSON.parse(raw) : {});
  } catch {
    return {};
  }
};

const writeStoredCountdowns = (countdowns) => {
  if (!canUseStorage()) return;

  try {
    const entries = Object.entries(countdowns || {});
    if (entries.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can fail in private mode; the in-memory timer still works.
  }
};

const requestNotificationPermission = () => {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  const request = Notification.requestPermission();
  if (request?.catch) request.catch(() => {});
};

export const useConnectionCountdowns = () => {
  const { notify } = useNotify();
  const [countdowns, setCountdowns] = useState(readStoredCountdowns);
  const [now, setNow] = useState(Date.now());
  const notifiedRef = useRef(new Set());

  const commitCountdowns = useCallback((updater) => {
    setCountdowns((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      writeStoredCountdowns(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const expired = Object.values(countdowns).filter((countdown) => Number(countdown.endsAt) <= now);
    if (expired.length === 0) return;

    commitCountdowns((current) => {
      const next = { ...current };
      expired.forEach((countdown) => {
        delete next[countdown.sessionId];
      });
      return next;
    });

    expired.forEach((countdown) => {
      if (notifiedRef.current.has(countdown.sessionId)) return;
      notifiedRef.current.add(countdown.sessionId);
      const message = `El teléfono de ${countdown.sessionId} ya se desbloqueó y se puede volver a conectar.`;
      notify({
        message,
        severity: 'success',
        duration: 7000
      });
      dispatchLocalNotification({
        id: `connection-countdown-${countdown.sessionId}-${countdown.endsAt}`,
        title: 'Teléfono desbloqueado',
        message,
        route: '/whatsapp',
        actionLabel: 'Ver conexiones',
        browserTitle: 'Teléfono desbloqueado',
        browserBody: `La conexión ${countdown.sessionId} ya se puede volver a conectar.`
      });
    });
  }, [commitCountdowns, countdowns, notify, now]);

  const startCountdown = useCallback(
    (sessionId, durationMs) => {
      const cleanSessionId = (sessionId || '').trim();
      const cleanDuration = Number(durationMs);
      if (!cleanSessionId || !Number.isFinite(cleanDuration) || cleanDuration <= 0) return;

      requestNotificationPermission();
      notifiedRef.current.delete(cleanSessionId);

      const startedAt = Date.now();
      commitCountdowns((current) => ({
        ...current,
        [cleanSessionId]: {
          sessionId: cleanSessionId,
          startedAt,
          endsAt: startedAt + cleanDuration
        }
      }));
      setNow(startedAt);
    },
    [commitCountdowns]
  );

  const cancelCountdown = useCallback(
    (sessionId) => {
      const cleanSessionId = (sessionId || '').trim();
      if (!cleanSessionId) return;

      commitCountdowns((current) => {
        const next = { ...current };
        delete next[cleanSessionId];
        return next;
      });
    },
    [commitCountdowns]
  );

  return {
    countdowns,
    now,
    startCountdown,
    cancelCountdown
  };
};
