import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  createSessionApi,
  listSessionsApi,
  getSessionStatusApi,
  getSessionQrApi,
  requestPairingCodeApi,
  reconnectSessionApi,
  renewQrSessionApi,
  resetAuthSessionApi,
  disconnectSessionApi,
  deleteSessionApi,
  updateSessionSettingsApi
} from '../api/whatsapp.js';
import { ApiError } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';
import { createAuditService } from '../services/audit.service.js';
import { useNotify } from './NotifyContext.jsx';
import { normalizeWhatsAppStatus } from '../utils/whatsappStatus.js';

const WhatsappSessionsContext = createContext(null);

const initialState = {
  sessions: {},
  activeQrSessionId: null,
  activePairingSessionId: null,
  globalError: null
};

const setSession = (state, id, patch) => {
  const current = state.sessions[id] || { id, session: id, status: null, loading: false };
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [id]: { ...current, id, session: id, ...patch }
    }
  };
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'SET_SESSION':
      return setSession(state, action.id, action.patch);
    case 'REMOVE_SESSION': {
      const next = { ...state.sessions };
      delete next[action.id];
      return { ...state, sessions: next };
    }
    case 'SET_ACTIVE_QR':
      return { ...state, activeQrSessionId: action.id };
    case 'CLEAR_ACTIVE_QR':
      return { ...state, activeQrSessionId: null };
    case 'SET_ACTIVE_PAIRING':
      return { ...state, activePairingSessionId: action.id };
    case 'CLEAR_ACTIVE_PAIRING':
      return { ...state, activePairingSessionId: null };
    case 'SET_GLOBAL_ERROR':
      return { ...state, globalError: action.message };
    default:
      return state;
  }
};

const handleApiError = async (err, logout, dispatch, auditService, contextEvent) => {
  const message =
    err instanceof ApiError ? err.message || 'Error en API de WhatsApp' : err?.message || 'Error en API de WhatsApp';
  if (auditService) {
    auditService
      .sendEvent({
        event: err?.status === 401 || err?.status === 403 ? 'access_denied' : 'api_error',
        metadata: { contextEvent, status: err?.status || null, message }
      })
      .catch(() => {});
  }
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    await logout({ remote: false, reason: message });
  }
  dispatch({ type: 'SET_GLOBAL_ERROR', message });
  return message;
};

export const WhatsappSessionsProvider = ({ children }) => {
  const { logout, apiClientInstance, token } = useAuth();
  const [state, dispatch] = useReducer(reducer, initialState);
  const pollers = useRef(new Map());
  const inFlightPolls = useRef(new Set());
  const lastQrFetchAt = useRef(new Map());
  const deletedSessions = useRef(new Set());
  const sessionsRef = useRef(initialState.sessions);
  const { notify } = useNotify();
  const auditService = useMemo(
    () =>
      createAuditService({
        getToken: () => token,
        onUnauthorized: async () => {
          await logout({ remote: false, reason: 'Sesión expirada o inválida' });
        }
      }),
    [token, logout]
  );

  const stopPolling = useCallback((sessionId) => {
    const timer = pollers.current.get(sessionId);
    if (timer) {
      clearInterval(timer);
      pollers.current.delete(sessionId);
    }
    inFlightPolls.current.delete(sessionId);
    lastQrFetchAt.current.delete(sessionId);
  }, []);

  const pollStatus = useCallback(
    async (sessionId) => {
      if (deletedSessions.current.has(sessionId)) return;
      if (inFlightPolls.current.has(sessionId)) return;
      inFlightPolls.current.add(sessionId);
      try {
        const statusResp = await getSessionStatusApi(apiClientInstance, sessionId);
        const status = normalizeWhatsAppStatus(statusResp.status);
        const patch = {
          status,
          lastConnectedAt: statusResp.lastConnectedAt || null,
          hasConnected: Boolean(statusResp.lastConnectedAt || status === 'connected'),
          hasStoredKeys: Boolean(statusResp.hasStoredKeys),
          syncHistory: Boolean(statusResp.syncHistory),
          historySyncStatus: statusResp.historySyncStatus || 'idle',
          historySyncedAt: statusResp.historySyncedAt || null,
          historySyncProgress: statusResp.historySyncProgress || {},
          syncHistoryUpdating: false,
          loading: false,
          error: null
        };
        if ((patch.status === 'pending' || patch.status === 'connecting') && !statusResp.qr && !statusResp.qrBase64) {
          const now = Date.now();
          const lastQrAt = lastQrFetchAt.current.get(sessionId) || 0;
          const currentSession = sessionsRef.current[sessionId] || {};
          if (now - lastQrAt >= 15000) {
            lastQrFetchAt.current.set(sessionId, now);
            const qrResp = await getSessionQrApi(apiClientInstance, sessionId);
            patch.qr = qrResp.qr || null;
            patch.qrBase64 = qrResp.qrBase64 || null;
            if (patch.qr || patch.qrBase64) {
              patch.status = 'pending';
            }
          } else {
            patch.qr = currentSession.qr || null;
            patch.qrBase64 = currentSession.qrBase64 || null;
          }
        } else {
          patch.qr = statusResp.qr || null;
          patch.qrBase64 = statusResp.qrBase64 || null;
        }
        dispatch({ type: 'SET_SESSION', id: sessionId, patch });
        if (patch.status === 'connected') {
          dispatch({ type: 'CLEAR_ACTIVE_QR' });
          stopPolling(sessionId);
        }
      } catch (err) {
        await handleApiError(err, logout, dispatch, auditService, 'poll_status');
      } finally {
        inFlightPolls.current.delete(sessionId);
      }
    },
    [apiClientInstance, auditService, logout, stopPolling]
  );

  const startPolling = useCallback(
    (sessionId) => {
      if (pollers.current.has(sessionId)) return;
      const timer = setInterval(() => pollStatus(sessionId), 4000);
      pollers.current.set(sessionId, timer);
    },
    [pollStatus]
  );

  useEffect(() => {
    return () => {
      pollers.current.forEach((t) => clearInterval(t));
      pollers.current.clear();
      inFlightPolls.current.clear();
      lastQrFetchAt.current.clear();
    };
  }, []);

  // Refresco periódico de estado para todas las sesiones visibles (solo GET)
  useEffect(() => {
    const timer = setInterval(() => {
      const ids = Object.keys(sessionsRef.current || {});
      ids.forEach((id) => {
        if (!pollers.current.has(id)) pollStatus(id);
      });
    }, 15000);
    return () => clearInterval(timer);
  }, [pollStatus]);

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  const syncSession = useCallback(
    async (sessionId = 'default', { allowCreate = false } = {}) => {
      dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: true, error: null } });
      try {
        let statusResp = await getSessionStatusApi(apiClientInstance, sessionId);
        if (allowCreate && statusResp?.status === 'deleted') {
          await createSessionApi(apiClientInstance, sessionId);
          statusResp = await getSessionStatusApi(apiClientInstance, sessionId);
        }
        const status = normalizeWhatsAppStatus(statusResp?.status);
        const patch = {
          status,
          qr: statusResp.qr || null,
          qrBase64: statusResp.qrBase64 || null,
          pairingCode: null,
          lastConnectedAt: statusResp.lastConnectedAt || null,
          hasConnected: Boolean(statusResp.lastConnectedAt || status === 'connected'),
          hasStoredKeys: Boolean(statusResp.hasStoredKeys),
          syncHistory: Boolean(statusResp.syncHistory),
          historySyncStatus: statusResp.historySyncStatus || 'idle',
          historySyncedAt: statusResp.historySyncedAt || null,
          historySyncProgress: statusResp.historySyncProgress || {},
          syncHistoryUpdating: false,
          loading: false,
          error: null
        };
        if (!patch.qr && !patch.qrBase64 && (patch.status === 'pending' || patch.status === 'connecting')) {
          const qrResp = await getSessionQrApi(apiClientInstance, sessionId);
          patch.qr = qrResp.qr || null;
          patch.qrBase64 = qrResp.qrBase64 || null;
          if (patch.qr || patch.qrBase64) {
            patch.status = 'pending';
          }
        }
        dispatch({ type: 'SET_SESSION', id: sessionId, patch });
        if (patch.status === 'connected' && state.activeQrSessionId === sessionId) {
          dispatch({ type: 'CLEAR_ACTIVE_QR' });
        }
        dispatch({ type: 'SET_GLOBAL_ERROR', message: null });
        auditService
          .sendEvent({ event: 'whatsapp_status', metadata: { sessionId, status: patch.status } })
          .catch(() => {});
        if (patch.status === 'pending' || patch.status === 'connecting') {
          startPolling(sessionId);
        } else {
          stopPolling(sessionId);
        }
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'sync_session');
        // Si 404 y no se permite crear, solo marca error; si se permite, intenta crear y reconsultar
        if (err instanceof ApiError && err.status === 404 && allowCreate) {
          try {
            await createSessionApi(apiClientInstance, sessionId);
            const statusResp = await getSessionStatusApi(apiClientInstance, sessionId);
            const status = normalizeWhatsAppStatus(statusResp.status);
            dispatch({
              type: 'SET_SESSION',
              id: sessionId,
              patch: {
                status,
                qr: statusResp.qr || null,
                qrBase64: statusResp.qrBase64 || null,
              pairingCode: null,
              lastConnectedAt: statusResp.lastConnectedAt || null,
              hasConnected: Boolean(statusResp.lastConnectedAt || status === 'connected'),
              hasStoredKeys: Boolean(statusResp.hasStoredKeys),
              syncHistory: Boolean(statusResp.syncHistory),
              historySyncStatus: statusResp.historySyncStatus || 'idle',
              historySyncedAt: statusResp.historySyncedAt || null,
                historySyncProgress: statusResp.historySyncProgress || {},
                syncHistoryUpdating: false,
                loading: false,
                error: null
              }
            });
            return;
          } catch (innerErr) {
            const innerMsg = await handleApiError(innerErr, logout, dispatch, auditService, 'sync_session_create');
            dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: false, error: innerMsg } });
            return;
          }
        }
        dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, auditService, startPolling, stopPolling, state.activeQrSessionId]
  );

  const loadExistingSessions = useCallback(async () => {
    try {
      const list = await listSessionsApi(apiClientInstance);
      const remoteIds = new Set(list.map((s) => (s.session || s.id || '').trim()).filter(Boolean));
      list.forEach((s) => {
        const sessionId = (s.session || s.id || 'default').trim();
        if (deletedSessions.current.has(sessionId)) {
          return; // ignorar sesiones marcadas como borradas hasta que desaparezcan del backend
        }
        dispatch({
          type: 'SET_SESSION',
          id: sessionId,
          patch: {
            session: sessionId,
            status: normalizeWhatsAppStatus(s.status),
            lastConnectedAt: s.lastConnectedAt || null,
            updatedAt: s.updatedAt || null,
            hasConnected: Boolean(s.lastConnectedAt),
            hasStoredKeys: Boolean(s.hasStoredKeys),
            syncHistory: Boolean(s.syncHistory),
            historySyncStatus: s.historySyncStatus || 'idle',
            historySyncedAt: s.historySyncedAt || null,
            historySyncProgress: s.historySyncProgress || {},
            syncHistoryUpdating: false,
            loading: false,
            error: null
          }
        });
      });
      // Eliminar de estado sesiones que ya no existen en backend
      Object.keys(sessionsRef.current || {}).forEach((id) => {
        if (!remoteIds.has(id)) {
          dispatch({ type: 'REMOVE_SESSION', id });
          deletedSessions.current.add(id);
        }
      });
      // Refrescar estado en vivo inmediatamente (solo GET)
      await Promise.all(
        list
          .map((s) => (s.session || s.id || '').trim())
          .filter((id) => id && !deletedSessions.current.has(id))
          .map((id) => pollStatus(id))
      );
    } catch (err) {
      await handleApiError(err, logout, dispatch, auditService, 'list_sessions');
    }
  }, [apiClientInstance, logout, auditService, pollStatus]);

  const updateSyncHistory = useCallback(
    async (sessionId = 'default', enabled = false) => {
      const cleanId = (sessionId || 'default').trim();
      dispatch({ type: 'SET_SESSION', id: cleanId, patch: { syncHistoryUpdating: true, error: null } });
      try {
        const res = await updateSessionSettingsApi(apiClientInstance, cleanId, { syncHistory: enabled });
        dispatch({
          type: 'SET_SESSION',
          id: cleanId,
          patch: {
            syncHistory: res?.syncHistory ?? enabled,
            historySyncStatus: res?.historySyncStatus || 'idle',
            historySyncedAt: res?.historySyncedAt || null,
            historySyncProgress: res?.historySyncProgress || {},
            syncHistoryUpdating: false
          }
        });
        notify({
          message: enabled ? 'Sincronización de historial activada' : 'Sincronización de historial desactivada',
          severity: 'success'
        });
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'sync_history_toggle');
        dispatch({ type: 'SET_SESSION', id: cleanId, patch: { syncHistoryUpdating: false, error: message } });
        notify({ message, severity: 'error' });
      }
    },
    [apiClientInstance, logout, auditService, notify]
  );

  const showQr = useCallback(
    async (sessionId = 'default') => {
      dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: true, error: null } });
      try {
        const qrResp = await getSessionQrApi(apiClientInstance, sessionId);
        const hasQr = Boolean(qrResp.qr || qrResp.qrBase64);
        dispatch({
          type: 'SET_SESSION',
          id: sessionId,
          patch: {
            qr: qrResp.qr || null,
            qrBase64: qrResp.qrBase64 || null,
            status: hasQr ? 'pending' : normalizeWhatsAppStatus(qrResp.status, 'pending'),
            hasStoredKeys: Boolean(qrResp.hasStoredKeys),
            loading: false
          }
        });
        dispatch({ type: 'SET_ACTIVE_QR', id: sessionId });
        dispatch({ type: 'SET_GLOBAL_ERROR', message: null });
        startPolling(sessionId);
        auditService.sendEvent({ event: 'whatsapp_status', metadata: { sessionId, status: 'pending' } }).catch(() => {});
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'show_qr');
        dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, auditService, startPolling]
  );

  const requestPairing = useCallback(
    async (sessionId = 'default', phone) => {
      dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: true, error: null } });
      try {
        const res = await requestPairingCodeApi(apiClientInstance, sessionId, phone);
        dispatch({
          type: 'SET_SESSION',
          id: sessionId,
          patch: { pairingCode: res, status: 'pairing_code', loading: false, error: null }
        });
        dispatch({ type: 'SET_ACTIVE_PAIRING', id: sessionId });
        dispatch({ type: 'SET_GLOBAL_ERROR', message: null });
        auditService.sendEvent({ event: 'whatsapp_pairing_requested', metadata: { sessionId } }).catch(() => {});
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'pairing_request');
        dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, auditService]
  );

  const reconnect = useCallback(
    async (sessionId = 'default') => {
      dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: true, error: null } });
      try {
        await reconnectSessionApi(apiClientInstance, sessionId);
        await syncSession(sessionId);
        startPolling(sessionId);
        auditService.sendEvent({ event: 'whatsapp_reconnect', metadata: { sessionId } }).catch(() => {});
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'reconnect');
        dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, syncSession, auditService, startPolling]
  );

  const renewQr = useCallback(
    async (sessionId = 'default') => {
      const cleanId = (sessionId || 'default').trim();
      dispatch({
        type: 'SET_SESSION',
        id: cleanId,
        patch: { loading: true, error: null, qr: null, qrBase64: null, status: 'pending' }
      });
      dispatch({ type: 'SET_ACTIVE_QR', id: cleanId });
      try {
        await renewQrSessionApi(apiClientInstance, cleanId);
        await syncSession(cleanId);
        startPolling(cleanId);
        auditService.sendEvent({ event: 'whatsapp_qr_renewed', metadata: { sessionId: cleanId } }).catch(() => {});
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'renew_qr');
        dispatch({ type: 'SET_SESSION', id: cleanId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, syncSession, auditService, startPolling]
  );

  const resetAuth = useCallback(
    async (sessionId = 'default') => {
      const cleanId = (sessionId || 'default').trim();
      dispatch({
        type: 'SET_SESSION',
        id: cleanId,
        patch: {
          loading: true,
          error: null,
          status: 'pending',
          qr: null,
          qrBase64: null,
          pairingCode: null,
          hasStoredKeys: false
        }
      });
      dispatch({ type: 'SET_ACTIVE_QR', id: cleanId });
      try {
        await resetAuthSessionApi(apiClientInstance, cleanId);
        await syncSession(cleanId);
        startPolling(cleanId);
        auditService
          .sendEvent({ event: 'whatsapp_force_new_qr', metadata: { sessionId: cleanId } })
          .catch(() => {});
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'reset_auth');
        dispatch({ type: 'SET_SESSION', id: cleanId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, syncSession, auditService, startPolling]
  );

  const disconnect = useCallback(
    async (sessionId = 'default') => {
      dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: true, error: null } });
      try {
        await disconnectSessionApi(apiClientInstance, sessionId);
        dispatch({
          type: 'SET_SESSION',
          id: sessionId,
          patch: { status: 'disconnected', qr: null, qrBase64: null, pairingCode: null, loading: false }
        });
        stopPolling(sessionId);
        dispatch({ type: 'SET_GLOBAL_ERROR', message: null });
        auditService.sendEvent({ event: 'whatsapp_disconnect', metadata: { sessionId } }).catch(() => {});
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'disconnect');
        dispatch({ type: 'SET_SESSION', id: sessionId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, auditService, stopPolling]
  );

  const deleteSession = useCallback(
    async (sessionId = 'default') => {
      const cleanId = (sessionId || 'default').trim();
      dispatch({ type: 'SET_SESSION', id: cleanId, patch: { loading: true, error: null } });
      try {
        stopPolling(cleanId);
        await deleteSessionApi(apiClientInstance, cleanId);
        dispatch({ type: 'REMOVE_SESSION', id: cleanId });
        deletedSessions.current.add(cleanId);
        if (state.activeQrSessionId === cleanId) {
          dispatch({ type: 'CLEAR_ACTIVE_QR' });
        }
        if (state.activePairingSessionId === cleanId) {
          dispatch({ type: 'CLEAR_ACTIVE_PAIRING' });
        }
        auditService.sendEvent({ event: 'whatsapp_session_deleted', metadata: { sessionId: cleanId } }).catch(() => {});
        // Forzar sincronización desde backend para reflejar eliminación real.
        await loadExistingSessions();
      } catch (err) {
        const message = await handleApiError(err, logout, dispatch, auditService, 'delete_session');
        dispatch({ type: 'SET_SESSION', id: cleanId, patch: { loading: false, error: message } });
      }
    },
    [apiClientInstance, logout, auditService, stopPolling, state.activePairingSessionId, state.activeQrSessionId, loadExistingSessions]
  );

  const setPhone = useCallback((sessionId, phone) => {
    dispatch({ type: 'SET_SESSION', id: sessionId, patch: { phone } });
  }, []);

  const value = useMemo(
    () => {
      const sessionsList = Object.values(state.sessions);
      const attention = sessionsList.filter((s) => {
        if (!s.status) return false;
        const offline = s.status === 'disconnected' || s.status === 'invalid';
        const waitingFirstConnect = (s.status === 'pending' || s.status === 'connecting') && !s.hasConnected;
        return offline || waitingFirstConnect;
      }).length;
      return {
        sessions: sessionsList,
        sessionsMeta: {
          attention,
          total: sessionsList.length
        },
        activeQrSessionId: state.activeQrSessionId,
        activePairingSessionId: state.activePairingSessionId,
        globalError: state.globalError,
        actions: {
          syncSession,
          deleteSession,
          loadExistingSessions,
          showQr,
          requestPairing,
          reconnect,
          renewQr,
          resetAuth,
          disconnect,
          updateSyncHistory,
          setPhone,
          setActiveQr: (id) => dispatch({ type: 'SET_ACTIVE_QR', id }),
          clearQr: () => dispatch({ type: 'CLEAR_ACTIVE_QR' }),
          clearPairing: () => dispatch({ type: 'CLEAR_ACTIVE_PAIRING' })
        }
      };
    },
    [
      state.sessions,
      state.activeQrSessionId,
      state.activePairingSessionId,
      state.globalError,
      syncSession,
      deleteSession,
      loadExistingSessions,
      showQr,
      requestPairing,
      reconnect,
      renewQr,
      resetAuth,
      disconnect,
      updateSyncHistory,
      setPhone
    ]
  );

  return <WhatsappSessionsContext.Provider value={value}>{children}</WhatsappSessionsContext.Provider>;
};

export const useWhatsappSessions = () => {
  const ctx = useContext(WhatsappSessionsContext);
  if (!ctx) throw new Error('useWhatsappSessions must be used within WhatsappSessionsProvider');
  return ctx;
};
