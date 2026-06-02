import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Autocomplete,
  Chip,
  CircularProgress,
  Snackbar,
  Alert,
  Tabs,
  Tab,
  Stack,
  Typography,
  TextField,
  InputAdornment,
  IconButton,
  Button,
  Avatar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
  FormHelperText
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import { useSearchParams } from 'react-router-dom';
import PageLayout from '../components/PageLayout.jsx';
import ChatInbox from '../components/chatExclusive/ChatInbox.jsx';
import ChatWindow from '../components/chatExclusive/ChatWindow.jsx';
import ReassignModal from '../components/chatExclusive/ReassignModal.jsx';
import ContactInfoModal from '../components/chatExclusive/ContactInfoModal.jsx';
import createChatService from '../services/chat.service.js';
import createQueueMembershipService from '../services/queueMembership.service.js';
import { createWhatsappService } from '../services/whatsapp.service.js';
import createQuickRepliesService from '../services/quickReplies.service.js';
import { useAuth } from '../context/AuthContext.jsx';
import { ApiError } from '../api/client.js';
import { getEventsSocket } from '../lib/eventsSocket.js';
import createContactsApi from '../api/contacts.api.js';
import { normalizePhoneNumber } from '../utils/phone.js';
import { isWhatsAppConnected, normalizeWhatsAppStatus } from '../utils/whatsappStatus.js';

const COUNTRY_OPTIONS = [
  { code: '52', label: 'México (+52)' },
  { code: '1', label: 'EE.UU. / Canadá (+1)' },
  { code: '57', label: 'Colombia (+57)' },
  { code: '54', label: 'Argentina (+54)' },
  { code: '55', label: 'Brasil (+55)' },
  { code: '56', label: 'Chile (+56)' },
  { code: '51', label: 'Perú (+51)' },
  { code: '34', label: 'España (+34)' },
  { code: '44', label: 'Reino Unido (+44)' },
  { code: '33', label: 'Francia (+33)' },
  { code: '49', label: 'Alemania (+49)' },
  { code: '39', label: 'Italia (+39)' },
  { code: '91', label: 'India (+91)' },
  { code: '81', label: 'Japón (+81)' },
  { code: '971', label: 'Emiratos Árabes (+971)' }
];

const ChatView = () => {
  const { token, logout, user } = useAuth();
  const handleApiUnauthorized = useCallback(
    async (response) => {
      const status = response?.status ?? response;
      if (status === 401) {
        await logout({ remote: false, reason: 'Sesión expirada o inválida' });
      }
    },
    [logout]
  );
  const chatService = useMemo(
    () =>
      createChatService({
        getToken: () => token,
        onUnauthorized: handleApiUnauthorized
      }),
    [token, handleApiUnauthorized]
  );
  const queueService = useMemo(
    () =>
      createQueueMembershipService({
        getToken: () => token,
        onUnauthorized: handleApiUnauthorized
      }),
    [token, handleApiUnauthorized]
  );
  const whatsappService = useMemo(
    () =>
      createWhatsappService({
        getToken: () => token,
        onUnauthorized: handleApiUnauthorized
      }),
    [token, handleApiUnauthorized]
  );
  const quickReplyService = useMemo(
    () =>
      createQuickRepliesService({
        getToken: () => token,
        onUnauthorized: handleApiUnauthorized
      }),
    [token, handleApiUnauthorized]
  );
  const contactsApi = useMemo(
    () =>
      createContactsApi({
        getToken: () => token,
        onUnauthorized: handleApiUnauthorized
      }),
    [token, handleApiUnauthorized]
  );

  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState({});
  const [unread, setUnread] = useState({});
  const [contactBook, setContactBook] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [snackbar, setSnackbar] = useState(null);
  const socketRef = useRef(null);
  const role = user?.role;
  const [showReassign, setShowReassign] = useState(false);
  const [connections, setConnections] = useState([]);
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState({ OPEN: 0, UNASSIGNED: 0, CLOSED: 0 });
  const [activeTab, setActiveTab] = useState('OPEN');
  const [searchParams] = useSearchParams();
  const [queueFilter, setQueueFilter] = useState([]);
  const [userFilter, setUserFilter] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [chatCursor, setChatCursor] = useState(null);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [scrollKey, setScrollKey] = useState(0);
  const messageKeysRef = useRef({});
  const messageCursorRef = useRef({});
  const hasMoreRef = useRef({});
  const [messagesLoadingMap, setMessagesLoadingMap] = useState({});
  const [hasMoreMap, setHasMoreMap] = useState({});
  const activeTabRef = useRef(activeTab);
  const activeChatIdRef = useRef(activeChatId);
  const userRef = useRef(user);
  const chatsRef = useRef([]);
  const quickReplyCacheRef = useRef(new Map());
  const [connectionStatusMap, setConnectionStatusMap] = useState({});
  const connectionStatusMapRef = useRef({});
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatForm, setNewChatForm] = useState({
    sessionName: '',
    contact: '',
    queueId: '',
    countryCode: COUNTRY_OPTIONS[0].code
  });
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [availableConnections, setAvailableConnections] = useState([]);
  const connectedConnections = useMemo(
    () => availableConnections.filter((c) => isWhatsAppConnected(c.status)),
    [availableConnections]
  );
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const contactLoadingRef = useRef(new Set());
  const selectedCountry = useMemo(
    () => COUNTRY_OPTIONS.find((c) => c.code === newChatForm.countryCode) || COUNTRY_OPTIONS[0],
    [newChatForm.countryCode]
  );
  const selectedConnection = useMemo(
    () => availableConnections.find((c) => c.name === newChatForm.sessionName) || null,
    [availableConnections, newChatForm.sessionName]
  );
  const connectionQueues = useMemo(() => selectedConnection?.queues || [], [selectedConnection]);
  const newChatContactValue = useMemo(() => {
    const digits = normalizePhoneNumber(newChatForm.contact);
    const code = normalizePhoneNumber(newChatForm.countryCode);
    if (!digits) return '';
    if (code && !digits.startsWith(code)) return `${code}${digits}`;
    return digits;
  }, [newChatForm.contact, newChatForm.countryCode]);

  const activeChat = useMemo(() => chats.find((c) => c.id === activeChatId), [chats, activeChatId]);
  const isActiveChatMine = useMemo(() => {
    if (!activeChat || !user?.id) return false;
    return activeChat.assignedUserId === user.id || activeChat.assignedAgentId === user.id;
  }, [activeChat, user?.id]);

  const canAgentTransfer = role === 'AGENTE' && activeChat?.status === 'OPEN' && Boolean(activeChat?.queueId) && isActiveChatMine;
  const canOpenReassign = role === 'ADMIN' || role === 'SUPERVISOR' || canAgentTransfer;

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useEffect(() => {
    connectionStatusMapRef.current = connectionStatusMap;
  }, [connectionStatusMap]);

  useEffect(() => {
    quickReplyCacheRef.current.clear();
  }, [token]);
  useEffect(() => {
    setContactBook({});
    contactLoadingRef.current = new Set();
  }, [token]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [moderating, setModerating] = useState({ delete: false });
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [contactModalError, setContactModalError] = useState('');
  const [contactModalAvatar, setContactModalAvatar] = useState(null);
  const [contactSaving, setContactSaving] = useState(false);

  const applyConnectionStatusUpdates = useCallback((updates = {}) => {
    const entries = Object.entries(updates || {})
      .map(([session, status]) => [session, normalizeWhatsAppStatus(status, '')])
      .filter(([session, status]) => session && status);
    if (!entries.length) return;
    const normalized = Object.fromEntries(entries);
    setConnectionStatusMap((prev) => {
      const next = { ...prev, ...normalized };
      connectionStatusMapRef.current = next;
      return next;
    });
    setChats((prev) =>
      prev.map((c) => {
        const session = c.whatsappSessionName || c.whatsapp_session_name || c.connectionId || null;
        if (session && normalized[session]) {
          return { ...c, whatsappStatus: normalized[session] };
        }
        return c;
      })
    );
    setAvailableConnections((prev) =>
      prev.map((c) => (c.name && normalized[c.name] ? { ...c, status: normalized[c.name] } : c))
    );
    setConnections((prev) =>
      prev.map((c) => {
        const session = c.sessionName || c.name || null;
        return session && normalized[session] ? { ...c, status: normalized[session] } : c;
      })
    );
  }, []);

  const refreshWhatsappStatuses = useCallback(async () => {
    try {
      const list = await whatsappService.listSessions();
      const statusUpdates = {};
      (list || []).forEach((s) => {
        const session =
          s.sessionName || s.session || s.session_name || s.id || s.name || s.sessionId || s.session_id || null;
        const status = s.status || s.state || null;
        if (session && status) statusUpdates[session] = status;
      });
      if (Object.keys(statusUpdates).length) {
        applyConnectionStatusUpdates(statusUpdates);
      }
    } catch (_err) {
      // Ignorar errores iniciales; el socket actualizará cuando haya eventos.
    }
  }, [applyConnectionStatusUpdates, whatsappService]);

  useEffect(() => {
    setDeleteTarget(null);
    setContactModalOpen(false);
    setContactModalError('');
  }, [activeChatId]);

  const getMessageKey = useCallback((m) => {
    if (!m) return null;
    return (
      m.whatsappMessageId ||
      m.id ||
      m?.content?.messageId ||
      m?.content?.id ||
      `${m?.direction || ''}-${m?.content?.text || ''}-${m?.timestamp || m?.createdAt || ''}`
    );
  }, []);

  const hasRenderableContent = useCallback((m) => {
    if (!m || !m.content) return false;
    const content = m.content;
    if (typeof content === 'string' && content.trim()) return true;
    if (content.text && content.text.trim && content.text.trim()) return true;
    if (content.media) return true;
    const p = content.payload || content.message || null;
    if (p) {
      if (p.conversation) return true;
      if (p.extendedTextMessage?.text) return true;
      if (p.message?.conversation) return true;
      if (p.message?.extendedTextMessage?.text) return true;
    }
    return false;
  }, []);

  const dedupeMessages = useCallback((items = []) => {
    const sortValue = (m) => Number(new Date(m?.timestamp || m?.createdAt || 0).getTime()) || 0;
    const createdValue = (m) => Number(new Date(m?.createdAt || m?.timestamp || 0).getTime()) || 0;
    const idValue = (m) => m?.whatsappMessageId || m?.id || '';
    const map = new Map();
    for (const m of items) {
      if (!m) continue;
      if (!hasRenderableContent(m) && m.status !== 'deleted') continue;
      const key = getMessageKey(m);
      const ts = sortValue(m);
      if (!map.has(key)) {
        map.set(key, { ...m, timestamp: m.timestamp || m.createdAt });
      } else {
        const prev = map.get(key);
        const prevTs = sortValue(prev);
        if (ts > prevTs) {
          map.set(key, { ...m, timestamp: m.timestamp || m.createdAt });
        } else {
          // Combinar metadatos (estado, payload) aunque el timestamp sea igual/menor para no perder ACKs.
          map.set(key, {
            ...prev,
            ...m,
            status: m.status || prev.status,
            timestamp: prev.timestamp || m.timestamp || prev.createdAt || m.createdAt
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const ta = sortValue(a);
      const tb = sortValue(b);
      if (ta !== tb) return ta - tb;
      const ca = createdValue(a);
      const cb = createdValue(b);
      if (ca !== cb) return ca - cb;
      return idValue(a) < idValue(b) ? -1 : idValue(a) > idValue(b) ? 1 : 0;
    });
  }, [getMessageKey, hasRenderableContent]);

  const handleChatAccessLost = useCallback(
    (message = 'Este chat ya no está asignado o autorizado') => {
      const currentChatId = activeChatIdRef.current;
      if (!currentChatId) return;
      setActiveChatId(null);
      delete messageCursorRef.current[currentChatId];
      delete hasMoreRef.current[currentChatId];
      setSnackbar({ severity: 'warning', message });
      // Refrescar la lista para que refleje el estado real (asignado o no) sin expulsar al usuario.
      loadChats().catch(() => {});
    },
    [loadChats]
  );

  const handleError = (err, meta = {}) => {
    if (err instanceof ApiError && err.status === 403) {
      const targetChatId = meta?.chatId || null;
      if (targetChatId && targetChatId !== activeChatIdRef.current) {
        return;
      }
      handleChatAccessLost('Chat ya no disponible para tu usuario');
      return;
    }
    let msg = err instanceof ApiError ? err.message : err?.message || 'Error';
    setSnackbar({ severity: 'error', message: msg });
  };

  const searchQuickReplies = useCallback(
    async (term) => {
      const normalized = (term || '').trim().toLowerCase();
      const cacheKey = normalized || '_all';
      if (quickReplyCacheRef.current.has(cacheKey)) {
        return quickReplyCacheRef.current.get(cacheKey);
      }
      try {
        const res = await quickReplyService.list({ search: normalized, limit: 12, active: true });
        const items = res?.items || [];
        quickReplyCacheRef.current.set(cacheKey, items);
        return items;
      } catch (err) {
        handleError(err, { source: 'quick_reply_search' });
        return [];
      }
    },
    [quickReplyService]
  );

  const sendQuickReply = useCallback(
    async ({ quickReplyId, variables }) => {
      if (!activeChatId) throw new Error('Selecciona un chat');
      try {
        const result = await quickReplyService.send(quickReplyId, { chatId: activeChatId, variables });
        const message = result?.message || result;
        const normalizedMessage = message?.id ? { ...message, quickReply: result?.quickReply } : message;
        setMessages((prev) => {
          const list = prev[activeChatId] || [];
          const nextList = normalizedMessage ? dedupeMessages([...list, normalizedMessage]) : list;
          return { ...prev, [activeChatId]: nextList };
        });
        setUnread((prev) => ({ ...prev, [activeChatId]: 0 }));
        setSnackbar({ severity: 'success', message: 'Respuesta rápida enviada' });
        return normalizedMessage;
      } catch (err) {
        handleError(err, { source: 'quick_reply_send' });
        throw err;
      }
    },
    [activeChatId, quickReplyService, dedupeMessages]
  );

  const quickReplyApi = useMemo(
    () => ({ search: searchQuickReplies, send: sendQuickReply }),
    [searchQuickReplies, sendQuickReply]
  );

  const normalizeContactInput = useCallback((value) => normalizePhoneNumber(value), []);
  const normalizePhoneSafe = useCallback((value) => normalizePhoneNumber(value), []);
  const buildPhoneWithCountry = useCallback(
    (rawNumber, dialCode) => {
      const digits = normalizePhoneSafe(rawNumber);
      const code = normalizePhoneSafe(dialCode);
      if (!digits) return '';
      if (code && !digits.startsWith(code)) return `${code}${digits}`;
      return digits;
    },
    [normalizePhoneSafe]
  );

  const upsertContactInState = useCallback(
    (contact) => {
      if (!contact) return;
      const key = normalizePhoneSafe(contact.phoneNormalized || contact.phone || contact.phone_normalized || '');
      if (!key) return;
      const sanitized = {
        phoneNormalized: key,
        displayName: contact.displayName ?? contact.display_name ?? null,
        avatarRef: contact.avatarRef ?? contact.avatar_ref ?? null,
        metadata: contact.metadata || null,
        updatedAt: contact.updatedAt || contact.updated_at || null
      };
      setContactBook((prev) => ({ ...prev, [key]: sanitized }));
      return sanitized;
    },
    [normalizePhoneSafe]
  );

  const fetchContactByPhone = useCallback(
    async (phone) => {
      const normalized = normalizePhoneSafe(phone);
      if (!normalized) return null;
      if (contactBook[normalized]) return contactBook[normalized];
      if (contactLoadingRef.current.has(normalized)) return null;
      contactLoadingRef.current.add(normalized);
      try {
        const data = await contactsApi.getByPhone(normalized);
        const resolved = {
          phoneNormalized: data?.phoneNormalized || data?.phone_normalized || normalized,
          displayName: data?.displayName ?? data?.display_name ?? null,
          avatarRef: data?.avatarRef ?? data?.avatar_ref ?? null,
          metadata: data?.metadata || null,
          updatedAt: data?.updatedAt || data?.updated_at || null
        };
        setContactBook((prev) => ({ ...prev, [normalized]: resolved }));
        return resolved;
      } catch (_err) {
        return null;
      } finally {
        contactLoadingRef.current.delete(normalized);
      }
    },
    [contactBook, contactsApi, normalizePhoneSafe]
  );

  const preloadContactsForChats = useCallback(
    async (items = []) => {
      const phones = Array.from(
        new Set(
          (items || [])
            .map((c) => normalizePhoneSafe(c.remoteNumber || c.remote_number || ''))
            .filter((p) => p && !contactBook[p])
        )
      );
      if (!phones.length) return;
      await Promise.allSettled(phones.map((p) => fetchContactByPhone(p)));
    },
    [contactBook, fetchContactByPhone, normalizePhoneSafe]
  );

  const activeContact = useMemo(() => {
    const normalized = normalizePhoneSafe(activeChat?.remoteNumber || activeChat?.remote_number || '');
    if (!normalized) return null;
    return contactBook[normalized] || null;
  }, [activeChat?.remoteNumber, activeChat?.remote_number, contactBook, normalizePhoneSafe]);

  const hasOpenChatForContact = useCallback(
    (sessionName, contactValue) => {
      if (!sessionName || !contactValue) return false;
      const normalizedContact = normalizeContactInput(contactValue);
      return chats.some(
        (c) =>
          (c.whatsappSessionName || '').toLowerCase() === sessionName.toLowerCase() &&
          c.status === 'OPEN' &&
          normalizeContactInput(c.remoteNumber || '') === normalizedContact
      );
    },
    [chats, normalizeContactInput]
  );

  const loadConnectionsCatalog = useCallback(async () => {
    setConnectionsLoading(true);
    try {
      const response = await chatService.listConnections();
      const list = Array.isArray(response?.connections) ? response.connections : Array.isArray(response) ? response : [];
      const normalized = list.map((s) => ({
        name: s.sessionName || s.session_name || s.name,
        status: normalizeWhatsAppStatus(s.status || s.state),
        queues: Array.isArray(s.queues)
          ? s.queues
              .filter((q) => q && q.id && q.name)
              .map((q) => ({ id: q.id, name: q.name }))
          : []
      }));
      setAvailableConnections(normalized.filter((c) => c.name));
      const statusUpdates = {};
      normalized.forEach((c) => {
        if (c.name && c.status) statusUpdates[c.name] = c.status;
      });
      if (Object.keys(statusUpdates).length) {
        applyConnectionStatusUpdates(statusUpdates);
      }
    } catch (_err) {
      setAvailableConnections([]);
    } finally {
      setConnectionsLoading(false);
    }
  }, [chatService, applyConnectionStatusUpdates]);

  useEffect(() => {
    if (newChatOpen) {
      loadConnectionsCatalog();
    }
  }, [newChatOpen, loadConnectionsCatalog]);

  useEffect(() => {
    refreshWhatsappStatuses();
  }, [refreshWhatsappStatuses]);

  useEffect(() => {
    const autoQueueId = connectionQueues.length === 1 ? connectionQueues[0].id : '';
    setNewChatForm((prev) => {
      if (prev.sessionName !== selectedConnection?.name) return prev;
      if (prev.queueId === autoQueueId) return prev;
      return { ...prev, queueId: autoQueueId };
    });
  }, [connectionQueues, selectedConnection?.name]);

  const openNewChatModal = () => {
    setNewChatForm({ sessionName: '', contact: '', queueId: '', countryCode: COUNTRY_OPTIONS[0].code });
    setNewChatOpen(true);
  };

  const handleCreateChat = async () => {
    const sessionName = newChatForm.sessionName.trim();
    const queueId = newChatForm.queueId;
    const contact = buildPhoneWithCountry(newChatForm.contact.trim(), newChatForm.countryCode);
    if (!sessionName || !contact) {
      setSnackbar({ severity: 'warning', message: 'Conexión y contacto son requeridos' });
      return;
    }
    if (!queueId) {
      setSnackbar({ severity: 'warning', message: 'Selecciona una cola para la conexión' });
      return;
    }
    if (hasOpenChatForContact(sessionName, contact)) {
      setSnackbar({ severity: 'error', message: 'Ya existe un chat activo para este contacto en esta conexión' });
      return;
    }
    setNewChatLoading(true);
    try {
      const chat = await chatService.createChat({ sessionName, contact, queueId });
      if (chat?.id) {
        const connStatus = availableConnections.find((c) => c.name === sessionName)?.status || null;
        const normalized = mergeChatWithKnownConnection({ ...chat, whatsappStatus: chat.whatsappStatus || connStatus });
        if (connStatus) {
          applyConnectionStatusUpdates({ [sessionName]: connStatus });
        }
        setChats((prev) => {
          const map = new Map(prev.map((c) => [c.id, c]));
          map.set(normalized.id, { ...map.get(normalized.id), ...normalized });
          return Array.from(map.values());
        });
        setActiveChatId(chat.id);
        await loadMessages(chat.id);
        setSnackbar({ severity: 'success', message: 'Chat abierto' });
      }
      setNewChatOpen(false);
    } catch (err) {
      handleError(err, { source: 'create_chat' });
    } finally {
      setNewChatLoading(false);
    }
  };

  const isChatVisible = (chat) => {
    if (!chat) return false;
    if (role === 'ADMIN' || role === 'SUPERVISOR') return true;
    if (role === 'AGENTE') {
      return !chat.assignedUserId || chat.assignedUserId === user?.id;
    }
    return false;
  };

  const matchesTab = (chat) => {
    if (!chat) return false;
    if (activeTab === 'UNASSIGNED') return chat.status === 'UNASSIGNED';
    if (activeTab === 'CLOSED') return chat.status === 'CLOSED';
    return chat.status === 'OPEN';
  };

  const queueFilterOptions = useMemo(() => {
    const map = new Map();
    chats.forEach((c) => {
      const id = c.queueId || 'none';
      const name = c.queueName || c.queue?.name || (id === 'none' ? 'Sin cola' : 'Cola');
      if (!map.has(id)) {
        map.set(id, { id, name });
      }
    });
    return Array.from(map.values());
  }, [chats]);

  const userFilterOptions = useMemo(() => {
    const map = new Map();
    let hasUnassigned = false;
    chats.forEach((c) => {
      const id = c.assignedUserId || c.assignedAgentId || null;
      const name =
        c.assignedUserName ||
        c.assignedAgentName ||
        c.assignedUserEmail ||
        c.assignedAgentEmail ||
        (id ? 'Agente' : 'Sin asignar');
      const avatar = c.assignedUserAvatar || c.assignedAgentAvatar || null;
      if (id) {
        map.set(id, { id, name, avatar });
      } else {
        hasUnassigned = true;
      }
    });
    if (hasUnassigned) {
      map.set('unassigned', { id: 'unassigned', name: 'Sin asignar' });
    }
    return Array.from(map.values());
  }, [chats]);

  const filteredChats = useMemo(() => {
    if (role === 'AGENTE') return chats;
    const applyFilters = (chat) => {
      if (queueFilter.length) {
        const qKey = chat.queueId || 'none';
        if (!queueFilter.includes(qKey)) return false;
      }
      if (userFilter.length) {
        const uKey = chat.assignedUserId || chat.assignedAgentId || 'unassigned';
        if (!userFilter.includes(uKey)) return false;
      }
      return true;
    };
    return chats.filter(applyFilters);
  }, [chats, queueFilter, userFilter, role]);

  const adjustSummary = useCallback((prevStatus, newStatus) => {
    const norm = (s) => (s || '').toUpperCase();
    const prev = norm(prevStatus);
    const next = norm(newStatus);
    setSummary((curr) => {
      const res = { ...curr };
      if (prev && res[prev] !== undefined) res[prev] = Math.max(0, (res[prev] || 0) - 1);
      if (next && res[next] !== undefined) res[next] = (res[next] || 0) + 1;
      return res;
    });
  }, []);

  const normalizeChat = useCallback(
    (chat) => {
      if (!chat) return chat;
      const queueId = chat.queueId || chat.queue_id || chat.queue?.id || null;
      const sessionName = chat.whatsappSessionName || chat.whatsapp_session_name || chat.connectionId || null;
      const rawWhatsappStatus =
        chat.whatsappStatus ||
        chat.whatsapp_status ||
        chat.connectionStatus ||
        chat.connection_status ||
        (sessionName ? connectionStatusMapRef.current[sessionName] : null);
      const whatsappStatus = normalizeWhatsAppStatus(rawWhatsappStatus, null);
      const phone = chat.remoteNumber || chat.remote_number || chat.contact || '';
      const phoneNormalized = normalizePhoneSafe(phone);
      const contactInfo = phoneNormalized ? contactBook[phoneNormalized] : null;
      const baseAvatar =
        chat.remoteAvatar ||
        chat.remote_avatar ||
        chat.remoteProfilePic ||
        chat.remote_profile_pic ||
        chat.remoteProfilePicUrl ||
        chat.remote_profile_pic_url ||
        chat.profilePic ||
        chat.profile_pic ||
        chat.profilePicUrl ||
        chat.profile_pic_url ||
        chat.contactAvatar ||
        chat.contact_avatar ||
        chat.contactPhoto ||
        chat.contact_photo ||
        chat.contactPhotoUrl ||
        chat.contact_photo_url ||
        chat.contactImage ||
        chat.contact_image ||
        chat.contactImageUrl ||
        chat.contact_image_url ||
        chat.contactPicture ||
        chat.contact_picture ||
        chat.picture ||
        chat.avatar ||
        null;
      const contactAvatar = baseAvatar || contactInfo?.avatarRef || contactInfo?.avatar_ref || null;
      const displayName =
        contactInfo?.displayName ||
        chat.contactDisplayName ||
        chat.contactName ||
        chat.contact_name ||
        chat.pushName ||
        chat.remoteName ||
        phone ||
        'Contacto';
      return {
        ...chat,
        queueId,
        whatsappStatus,
        whatsappSessionName: sessionName,
        contactAvatar,
        contactDisplayName: contactInfo?.displayName ?? chat.contactDisplayName ?? null,
        phoneNormalized,
        remoteName: displayName
      };
    },
    [contactBook, normalizePhoneSafe]
  );

  const mergeChatWithKnownConnection = useCallback(
    (incomingChat, existingChat = null) => {
      if (!incomingChat && !existingChat) return null;
      const incomingSession =
        incomingChat?.whatsappSessionName ||
        incomingChat?.whatsapp_session_name ||
        incomingChat?.connectionId ||
        incomingChat?.connection_id ||
        null;
      const existingSession =
        existingChat?.whatsappSessionName ||
        existingChat?.whatsapp_session_name ||
        existingChat?.connectionId ||
        existingChat?.connection_id ||
        null;
      const sessionName = incomingSession || existingSession;
      const explicitStatus =
        incomingChat?.whatsappStatus ||
        incomingChat?.whatsapp_status ||
        incomingChat?.connectionStatus ||
        incomingChat?.connection_status ||
        null;
      const knownStatus =
        explicitStatus ||
        existingChat?.whatsappStatus ||
        existingChat?.whatsapp_status ||
        (sessionName ? connectionStatusMapRef.current[sessionName] : null);

      return normalizeChat({
        ...(existingChat || {}),
        ...(incomingChat || {}),
        whatsappSessionName: sessionName,
        whatsappStatus: normalizeWhatsAppStatus(knownStatus, null)
      });
    },
    [normalizeChat]
  );

  useEffect(() => {
    setChats((prev) => prev.map((c) => normalizeChat(c)));
  }, [normalizeChat]);

  const loadAgentsAndConnections = useCallback(
    async (queueId) => {
      if (!queueId) {
        setAgents([]);
        setConnections([]);
        return;
      }
      try {
        const [usersRes, connRes] = await Promise.all([
          queueService.listQueueUsers(queueId).catch((err) => {
            if (err?.status === 404) return null;
            throw err;
          }),
          queueService.listQueueConnections(queueId).catch((err) => {
            if (err?.status === 404) return [];
            throw err;
          })
        ]);

        const normalizedQueueAgents = (usersRes || []).map((u) => ({
          id: u.user_id || u.userId || u.id,
          name: u.name || u.email || u.username || u.user_id,
          role: u.role || u.queueRole || u.queue_role || u.role_name,
          queueIds: [queueId]
        }));

        const shouldFilterSelf = user?.role === 'AGENTE' && user?.id;

        let candidateAgents = normalizedQueueAgents;
        if (!candidateAgents.length) {
          if (user?.role === 'AGENTE') {
            candidateAgents = [];
          } else {
            candidateAgents = await queueService
              .listAllUsers()
              .then((all) =>
                (all || []).filter((u) => ['ADMIN', 'SUPERVISOR', 'AGENTE', 'AGENT'].includes((u.role || '').toUpperCase()))
              )
              .then((all) =>
                all.map((u) => ({
                  id: u.id,
                  name: u.fullName || u.name || u.email,
                  role: u.role,
                  queueIds: []
                }))
              )
              .catch(() => []);
          }
        }

        const filtered = shouldFilterSelf ? candidateAgents.filter((a) => a.id !== user.id) : candidateAgents;
        setAgents(filtered);

        const normalizedConns = (connRes || []).map((c) => ({
          sessionName: c.whatsapp_session_name || c.sessionName || c.name,
          status: normalizeWhatsAppStatus(c.status || c.connectionStatus || c.whatsapp_status, '')
        }));
        setConnections(normalizedConns);
        const statusUpdates = {};
        normalizedConns.forEach((c) => {
          if (c.sessionName && c.status) statusUpdates[c.sessionName] = c.status;
        });
        if (Object.keys(statusUpdates).length) {
          applyConnectionStatusUpdates(statusUpdates);
        }
      } catch (err) {
        // ignore load errors; modal will show empty lists
        setAgents([]);
        setConnections([]);
      }
    },
    [queueService, user?.id, user?.role, applyConnectionStatusUpdates]
  );

  async function loadChats(append = false) {
    if (!append) setChatCursor(null);
    if (append) setLoadingMoreChats(true);
    else setLoading(true);
    try {
      const data = await chatService.getChats({
        status: activeTab,
        search: searchTerm || undefined,
        cursor: append ? chatCursor : null,
        limit: 100
      });
      const itemsRaw = data?.items || data || [];
      const previousById = new Map((chatsRef.current || []).map((c) => [c.id, c]));
      const items = itemsRaw.map((c) => mergeChatWithKnownConnection(c, previousById.get(c.id)));
      preloadContactsForChats(items).catch(() => {});
      // Actualizar mapa de estado de conexión si viene en la respuesta
      const statusUpdates = {};
      itemsRaw.forEach((c) => {
        const session = c.whatsappSessionName || c.whatsapp_session_name || c.connectionId || null;
        const status = c.whatsappStatus || c.whatsapp_status || null;
        if (session && status) statusUpdates[session] = status;
      });
      if (Object.keys(statusUpdates).length) {
        applyConnectionStatusUpdates(statusUpdates);
      }
      const visible = (items || []).filter((c) => isChatVisible(c) && (matchesTab(c) || c.id === activeChatId));
      setChatCursor(data?.nextCursor || null);
      if (append) {
        setChats((prev) => {
          const map = new Map((prev || []).map((c) => [c.id, normalizeChat(c)]));
          visible.forEach((c) => map.set(c.id, mergeChatWithKnownConnection(c, map.get(c.id))));
          return Array.from(map.values());
        });
      } else {
        setChats(visible);
      }
      if (!activeChatId && visible?.length) {
        setActiveChatId(visible[0].id);
      }
    } catch (err) {
      handleError(err, { source: 'load_chats' });
    } finally {
      if (append) setLoadingMoreChats(false);
      else setLoading(false);
    }
  }

  const setLoadingMoreFor = (chatId, value) => {
    setMessagesLoadingMap((prev) => ({ ...prev, [chatId]: value }));
  };

  const loadMessagesWithCursor = async (chatId, { prepend = false, cursor = null, reset = false } = {}) => {
    if (!chatId) return;
    if (reset) {
      messageCursorRef.current[chatId] = null;
      hasMoreRef.current[chatId] = false;
      setHasMoreMap((prev) => ({ ...prev, [chatId]: false }));
    }
    if (prepend) setLoadingMoreFor(chatId, true);
    else setLoadingMsgs(true);
    try {
      const nextCursor = cursor !== null ? cursor : reset ? null : messageCursorRef.current[chatId] || null;
      const data = await chatService.getMessages(chatId, { cursor: nextCursor, limit: 30 });
      const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
      const deduped = dedupeMessages(list);
      messageCursorRef.current[chatId] = data?.nextCursor || null;
      hasMoreRef.current[chatId] = Boolean(data?.nextCursor);
      setHasMoreMap((prev) => ({ ...prev, [chatId]: Boolean(data?.nextCursor) }));
      setMessages((prev) => {
        const existing = reset ? [] : prev[chatId] || [];
        const merged = prepend ? dedupeMessages([...deduped, ...existing]) : dedupeMessages([...existing, ...deduped]);
        return { ...prev, [chatId]: merged };
      });
      if (!prepend) {
        setScrollKey((k) => k + 1);
      }
    } catch (err) {
      handleError(err, { source: 'load_messages', chatId });
    } finally {
      if (prepend) setLoadingMoreFor(chatId, false);
      else setLoadingMsgs(false);
    }
  };

  const loadMessages = async (chatId) => loadMessagesWithCursor(chatId, { prepend: false, cursor: null, reset: true });

  useEffect(() => {
    loadChats();
    const loadSummary = async () => {
      try {
        const data = await chatService.getChatSummary();
        setSummary({
          OPEN: data?.OPEN || 0,
          UNASSIGNED: data?.UNASSIGNED || 0,
          CLOSED: data?.CLOSED || 0
        });
      } catch (_err) {
        // ignore summary errors
      }
    };
    loadSummary();
  }, [activeTab, searchTerm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeChatId) {
      loadMessages(activeChatId);
      setUnread((prev) => ({ ...prev, [activeChatId]: 0 }));
    }
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeChat) return;
    fetchContactByPhone(activeChat.remoteNumber || activeChat.remote_number || '');
  }, [activeChat, fetchContactByPhone]);

  useEffect(() => {
    const chatIdParam = searchParams.get('chatId');
    if (chatIdParam) {
      setActiveChatId(chatIdParam);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!activeChatId) return;
    const stillVisible = chats.some((c) => c.id === activeChatId);
    if (!stillVisible) setActiveChatId(null);
  }, [chats, activeChatId]);

  useEffect(() => {
    if (role === 'AGENTE') return;
    if (!activeChatId) return;
    const visible = filteredChats.some((c) => c.id === activeChatId);
    if (!visible) setActiveChatId(null);
  }, [filteredChats, activeChatId, role]);

  useEffect(() => {
    if (!activeChat) return;
    if (role === 'AGENTE' && activeChat.status === 'CLOSED') {
      setActiveChatId(null);
      setActiveTab('OPEN');
      return;
    }
    if (!matchesTab(activeChat)) {
      const status = activeChat.status;
      const target = status === 'UNASSIGNED' ? 'UNASSIGNED' : status === 'CLOSED' ? 'CLOSED' : 'OPEN';
      if (target !== activeTab) setActiveTab(target);
    }
  }, [activeChat, activeTab, matchesTab, role]);

  const handleLoadMoreMessages = useCallback(() => {
    const cid = activeChatIdRef.current;
    if (!cid) return;
    const cursor = messageCursorRef.current[cid];
    if (!cursor) return;
    loadMessagesWithCursor(cid, { prepend: true, cursor });
  }, [loadMessagesWithCursor]);

  useEffect(() => {
    if (activeChat?.queueId) {
      loadAgentsAndConnections(activeChat.queueId);
    } else {
      setAgents([]);
      setConnections([]);
    }
  }, [activeChat?.queueId, loadAgentsAndConnections]);

  const handleCloseChat = async () => {
    if (!activeChatId) return;
    try {
      const prevStatus = activeChat?.status || null;
      await chatService.closeChat(activeChatId);
      adjustSummary(prevStatus, 'CLOSED');
      setChats((prev) =>
        prev
          .map((c) => (c.id === activeChatId ? { ...c, status: 'CLOSED' } : c))
          .filter((c) => (role === 'AGENTE' ? c.status !== 'CLOSED' : matchesTab(c) || c.id === activeChatId))
      );
      if (role === 'AGENTE') {
        setActiveChatId(null);
        setActiveTab('OPEN');
      } else {
        setActiveTab('CLOSED');
      }
      setSnackbar({ severity: 'success', message: 'Chat cerrado' });
      await loadChats();
      if (role !== 'AGENTE') await loadMessages(activeChatId);
    } catch (err) {
      handleError(err, { source: 'close_chat' });
    }
  };

  const handleReassignSuccess = useCallback(
    (updatedChat) => {
      if (!updatedChat) return false;
      const existing = chatsRef.current.find((c) => c.id === updatedChat.id) || null;
      const normalized = mergeChatWithKnownConnection(updatedChat, existing);
      const keepVisible =
        role !== 'AGENTE' ||
        normalized.assignedUserId === user?.id ||
        normalized.assignedAgentId === user?.id;

      setChats((prev) => {
        const map = new Map(prev.map((c) => [c.id, c]));
        if (keepVisible) {
          map.set(normalized.id, { ...map.get(normalized.id), ...normalized });
        } else {
          map.delete(normalized.id);
        }
        return Array.from(map.values());
      });

      if (keepVisible) {
        setActiveTab('OPEN');
        setActiveChatId(normalized.id);
        setSnackbar({ severity: 'success', message: 'Chat reasignado' });
      } else {
        if (activeChatId === normalized.id) setActiveChatId(null);
        setSnackbar({ severity: 'success', message: 'Chat transferido a otro agente' });
      }
      return keepVisible;
    },
    [mergeChatWithKnownConnection, role, user?.id, activeChatId]
  );

  const handleSend = async (payload) => {
    if (!activeChatId) return;
    try {
      let msg;
      if (payload.file) {
        msg = await chatService.sendMedia(activeChatId, payload.file, payload.text || '', {
          onProgress: payload.onProgress
        });
      } else {
        msg = await chatService.sendMessage(activeChatId, { text: payload.text || '' });
      }
      setMessages((prev) => {
        const list = prev[activeChatId] || [];
        return { ...prev, [activeChatId]: dedupeMessages([...list, msg]) };
      });
      setUnread((prev) => ({ ...prev, [activeChatId]: 0 }));
      setSnackbar({ severity: 'success', message: 'Mensaje enviado' });
      return msg;
    } catch (err) {
      const connName = activeChat?.whatsappSessionName || activeChat?.whatsapp_session_name || 'N/D';
      if (err instanceof ApiError && err.status >= 500) {
        setSnackbar({
          severity: 'error',
          message: `Valida la página de conexiones para la conexión: ${connName}`
        });
      } else {
        handleError(err, { source: 'send_message' });
      }
      throw err;
    }
  };

  const handleDeleteMessage = (message) => {
    if (!message) return;
    setDeleteTarget(message);
  };

  const confirmDeleteMessage = async () => {
    const target = deleteTarget;
    if (!target) return;
    const id = target.whatsappMessageId || target.id;
    setModerating((prev) => ({ ...prev, delete: true }));
    try {
      const updated = await chatService.deleteMessage(id);
      if (updated?.chatId) {
        setMessages((prev) => {
          const list = prev[updated.chatId] || [];
          const next = list.map((m) =>
            m.id === updated.id || m.whatsappMessageId === updated.whatsappMessageId ? { ...m, ...updated } : m
          );
          return { ...prev, [updated.chatId]: next };
        });
        await loadMessages(updated.chatId);
      }
      setSnackbar({ severity: 'success', message: 'Mensaje eliminado para cliente' });
      setDeleteTarget(null);
    } catch (err) {
      handleError(err, { source: 'delete_message' });
    } finally {
      setModerating((prev) => ({ ...prev, delete: false }));
    }
  };

  const handleAssignToMe = async () => {
    if (!activeChatId) return;
    try {
      const prevStatus = activeChat?.status || null;
      await chatService.assignChat(activeChatId);
      adjustSummary(prevStatus, 'OPEN');
      setActiveTab('OPEN');
      setChats((prev) =>
        prev
          .map((c) => (c.id === activeChatId ? { ...c, status: 'OPEN', assignedUserId: user?.id, assignedAgentId: user?.id } : c))
          .filter((c) => matchesTab(c) || c.id === activeChatId)
      );
      await loadChats();
      await loadMessages(activeChatId);
      setSnackbar({ severity: 'success', message: 'Chat asignado' });
    } catch (err) {
      handleError(err, { source: 'assign_chat' });
    }
  };

  const handleOpenContactModal = useCallback(
    ({ avatarUrl } = {}) => {
      if (!activeChat) return;
      setContactModalAvatar(
        avatarUrl ||
          activeChat.contactAvatar ||
          activeChat.remoteAvatar ||
          activeChat.remote_avatar ||
          activeChat.profilePic ||
          activeChat.profile_pic ||
          null
      );
      setContactModalError('');
      setContactModalOpen(true);
    },
    [activeChat]
  );

  const handleSaveContact = useCallback(
    async ({ displayName }) => {
      if (!activeChat) return;
      const phone = activeChat.remoteNumber || activeChat.remote_number || '';
      const normalized = normalizePhoneSafe(phone);
      if (!normalized) {
        setContactModalError('Número inválido');
        return;
      }
      const desiredName = typeof displayName === 'string' ? displayName.trim() : '';
      setContactSaving(true);
      setContactModalError('');
      try {
        const payload = await contactsApi.upsert({
          phone,
          displayName: desiredName
        });
        upsertContactInState(
          payload || {
            phoneNormalized: normalized,
            displayName: desiredName,
            avatarRef: activeContact?.avatarRef ?? null,
            metadata: activeContact?.metadata ?? null,
            updatedAt: new Date().toISOString()
          }
        );
        setSnackbar({ severity: 'success', message: 'Contacto actualizado' });
        setContactModalOpen(false);
      } catch (err) {
        setContactModalError(err?.message || 'No se pudo guardar el contacto');
      } finally {
        setContactSaving(false);
      }
    },
    [activeChat, activeContact?.avatarRef, activeContact?.metadata, contactsApi, normalizePhoneSafe, upsertContactInState]
  );

  useEffect(() => {
    if (!token) return;
    const socket = getEventsSocket(token);

    const shouldIgnore = (evt) => {
      const jid = evt?.chat?.remoteJid || evt?.message?.remoteJid || '';
      return typeof jid === 'string' && jid.endsWith('@g.us');
    };

    const isChatVisibleCurrent = (chat) => {
      if (!chat) return false;
      const currentRole = userRef.current?.role;
      const currentUserId = userRef.current?.id;
      if (currentRole === 'ADMIN' || currentRole === 'SUPERVISOR') return true;
      if (currentRole === 'AGENTE') {
        return !chat.assignedUserId || chat.assignedUserId === currentUserId;
      }
      return false;
    };

    const matchesTabCurrent = (chat) => {
      if (!chat) return false;
      const tab = activeTabRef.current;
      if (tab === 'UNASSIGNED') return chat.status === 'UNASSIGNED';
      if (tab === 'CLOSED') return chat.status === 'CLOSED';
      return chat.status === 'OPEN';
    };

    const handleStatusUpdate = (payload = {}) => {
      const data = payload.message || payload;
      const chatId = data.chatId || payload.chatId;
      const whatsappMessageId = data.whatsappMessageId || payload.whatsappMessageId;
      const messageId = data.id || payload.messageId;
      if (!chatId || !(whatsappMessageId || messageId)) return;
      const chatPayload = payload.chat || chatsRef.current.find((c) => c.id === chatId) || null;
      const isActiveChat = activeChatIdRef.current === chatId;
      const isVisible = chatPayload ? isChatVisibleCurrent(chatPayload) : isActiveChat;
      if (!isVisible) return;
      const normalized = {
        ...data,
        deletedForRemote: data.status === 'deleted' ? true : data.deletedForRemote,
        status: data.status || (data.deletedForRemote ? 'deleted' : data.status)
      };
      let needReload = false;
      if (normalized.status === 'deleted') {
        setMessages((prev) => {
          const list = prev[chatId] || [];
          let found = false;
          const next = list.map((m) => {
            if (m.whatsappMessageId === whatsappMessageId || m.id === messageId) {
              found = true;
              return { ...m, ...normalized };
            }
            return m;
          });
          if (!found) {
            needReload = true;
            return prev;
          }
          return { ...prev, [chatId]: dedupeMessages(next) };
        });
        if (needReload && isActiveChat) loadMessages(chatId);
        return;
      }
      setMessages((prev) => {
        const list = prev[chatId] || [];
        let found = false;
        const next = list.map((m) => {
          if (m.whatsappMessageId === whatsappMessageId || m.id === messageId) {
            found = true;
            return { ...m, ...normalized };
          }
          return m;
        });
        const hasContent =
          normalized && normalized.content && Object.keys(normalized.content).length > 0;
        const shouldAppend =
          !found &&
          hasContent &&
          (normalized.id || normalized.whatsappMessageId);
        if (shouldAppend) {
          next.push({ ...normalized, timestamp: normalized.timestamp || normalized.createdAt || Date.now() });
        } else if (!found) {
          needReload = true;
        }
        return { ...prev, [chatId]: dedupeMessages(next) };
      });
      if (needReload && isActiveChat) {
        loadMessages(chatId);
      }
    };

    const handleIncomingMessage = ({ chatId, message, chat }) => {
      if (!chatId || !message) return;
      if (shouldIgnore({ chat, message })) return;

      const key = getMessageKey(message);
      if (key) {
        const cache = messageKeysRef.current[chatId] || new Set();
        if (cache.has(key)) return;
        cache.add(key);
        if (cache.size > 500) {
          const toDrop = Array.from(cache).slice(0, cache.size - 500);
          toDrop.forEach((k) => cache.delete(k));
        }
        messageKeysRef.current[chatId] = cache;
      }

      let allowed = true;
      const currentActiveChatId = activeChatIdRef.current;

      let statusChange = null;

      if (chat) {
        const existing = chatsRef.current.find((c) => c.id === chat.id) || null;
        const normalizedChat = mergeChatWithKnownConnection(chat, existing);
        const visible = isChatVisibleCurrent(normalizedChat) && matchesTabCurrent(normalizedChat);
        setChats((prev) => {
          if (!visible) return prev.filter((c) => c.id !== normalizedChat.id);
          const exists = prev.find((c) => c.id === normalizedChat.id);
          statusChange = { prev: exists?.status, next: normalizedChat.status };
          if (exists) {
            return prev.map((c) =>
              c.id === normalizedChat.id ? mergeChatWithKnownConnection(normalizedChat, c) : c
            );
          }
          return [normalizedChat, ...prev];
        });
        if (!visible) {
          allowed = false;
          if (currentActiveChatId === normalizedChat.id) setActiveChatId(null);
        }
      } else {
        setChats((prev) => {
          const exists = prev.find((c) => c.id === chatId);
          if (!exists) {
            allowed = false;
            return prev;
          }
          const visible = isChatVisibleCurrent(exists);
          allowed = visible;
          return visible ? prev : prev.filter((c) => c.id !== chatId);
        });
      }
      if (!allowed) return;

      setMessages((prev) => {
        const list = prev[chatId] || [];
        const next = [...list, message].sort(
          (a, b) => new Date(a.createdAt || a.timestamp) - new Date(b.createdAt || b.timestamp)
        );
        return { ...prev, [chatId]: dedupeMessages(next) };
      });
      if (statusChange && statusChange.prev !== statusChange.next) {
        adjustSummary(statusChange.prev, statusChange.next);
      } else if (!statusChange && chat?.status) {
        // new chat not in state previously
        adjustSummary(null, chat.status);
      }
      if (currentActiveChatId !== chatId) {
        setUnread((prev) => ({ ...prev, [chatId]: (prev[chatId] || 0) + 1 }));
      } else {
        setScrollKey((k) => k + 1);
      }
    };

    socket.on('message:new', handleIncomingMessage);
    socket.on('message:media', handleIncomingMessage);
    socket.on('message:update', handleStatusUpdate);

    socket.on('chat:new', (chat) => {
      const existing = chatsRef.current.find((c) => c.id === chat?.id) || null;
      const normalizedChat = mergeChatWithKnownConnection(chat, existing);
      if (normalizedChat?.status) adjustSummary(null, normalizedChat.status);
      if (!isChatVisibleCurrent(normalizedChat) || !matchesTabCurrent(normalizedChat)) return;
      setChats((prev) => {
        if (prev.find((c) => c.id === normalizedChat.id)) return prev;
        return [normalizedChat, ...prev];
      });
    });

    socket.on('chat:auto-closed', ({ chat }) => {
      const target = chat || null;
      if (target?.id) {
        setSnackbar({ severity: 'info', message: 'Chat cerrado por inactividad' });
      }
      if (role === 'AGENTE') {
        setChats((prev) => prev.filter((c) => c.id !== target?.id));
        if (activeChatIdRef.current === target?.id) {
          setActiveChatId(null);
          setActiveTab('OPEN');
        }
      }
    });

    socket.on('chat:update', (chat) => {
      if (chat.hidden) {
        setChats((prev) => prev.filter((c) => c.id !== chat.id));
        if (activeChatIdRef.current === chat.id) setActiveChatId(null);
        return;
      }
      const sessionName = chat.whatsappSessionName || chat.whatsapp_session_name || chat.connectionId || null;
      const sessionStatus = chat.whatsappStatus || chat.whatsapp_status || chat.connectionStatus || null;
      if (sessionName && sessionStatus) {
        applyConnectionStatusUpdates({ [sessionName]: sessionStatus });
      }
      const existingChat = chatsRef.current.find((c) => c.id === chat.id) || null;
      const normalizedChat = mergeChatWithKnownConnection(chat, existingChat);
      const visible = isChatVisibleCurrent(normalizedChat) && matchesTabCurrent(normalizedChat);
      setChats((prev) => {
        const exists = prev.find((c) => c.id === chat.id);
        if (exists?.status && exists.status !== normalizedChat.status) {
          adjustSummary(exists.status, normalizedChat.status);
        }
        if (!visible) return prev.filter((c) => c.id !== chat.id);
        if (exists) return prev.map((c) => (c.id === chat.id ? mergeChatWithKnownConnection(normalizedChat, c) : c));
        adjustSummary(null, normalizedChat.status);
        return [normalizedChat, ...prev];
      });
      if (!visible && activeChatIdRef.current === chat.id) {
        setActiveChatId(null);
        if (role === 'AGENTE') setActiveTab('OPEN');
      }
      // Si el chat activo cambia de estado, navega a la pestaña correcta (no mover agentes a CLOSED)
      if (activeChatIdRef.current === chat.id && normalizedChat?.status) {
        const targetTab =
          role === 'AGENTE'
            ? 'OPEN'
            : normalizedChat.status === 'UNASSIGNED'
              ? 'UNASSIGNED'
              : normalizedChat.status === 'CLOSED'
                ? 'CLOSED'
                : 'OPEN';
        if (targetTab !== activeTabRef.current) {
          setActiveTab(targetTab);
        }
      }
    });

    const handleWhatsappStatus = (evt) => {
      if (!evt?.sessionId || !evt?.status) return;
      applyConnectionStatusUpdates({ [evt.sessionId]: evt.status });
    };
    socket.on('whatsapp:status', handleWhatsappStatus);
    const handleContactUpdated = (payload = {}) => {
      const normalized = normalizePhoneSafe(payload.phoneNormalized || payload.phone_normalized || payload.phone);
      if (!normalized) return;
      setContactBook((prev) => ({
        ...prev,
        [normalized]: {
          ...(prev[normalized] || {}),
          phoneNormalized: normalized,
          displayName: payload.displayName ?? payload.display_name ?? null,
          avatarRef: payload.avatarRef ?? payload.avatar_ref ?? null,
          metadata: payload.metadata || prev[normalized]?.metadata || null,
          updatedAt: payload.updatedAt || payload.updated_at || prev[normalized]?.updatedAt || null
        }
      }));
    };
    socket.on('contact.updated', handleContactUpdated);

    socketRef.current = socket;
    return () => {
      socket.off('message:new', handleIncomingMessage);
      socket.off('message:media', handleIncomingMessage);
      socket.off('message:update', handleStatusUpdate);
      socket.off('chat:new');
      socket.off('chat:update');
      socket.off('chat:auto-closed');
      socket.off('whatsapp:status', handleWhatsappStatus);
      socket.off('contact.updated', handleContactUpdated);
    };
  }, [token, applyConnectionStatusUpdates, normalizePhoneSafe]);

  return (
    <PageLayout title={null} subtitle={null}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center" sx={{ mb: 1, px: 1, flexWrap: 'wrap' }}>
        <Tabs
          value={activeTab}
          onChange={(_e, val) => {
            setActiveChatId(null);
            setActiveTab(val);
          }}
          variant="scrollable"
          scrollButtons="auto"
          sx={(theme) => ({
            borderBottom: `1px solid ${theme.palette.divider}`,
            backgroundColor: theme.semanticColors.surfaceSecondary,
            px: 1,
            borderRadius: 2,
            maxWidth: '100%'
          })}
          TabIndicatorProps={{ style: { display: 'none' } }}
        >
          {role !== 'AGENTE' && (
            <Tab
              value="UNASSIGNED"
              label={
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Typography variant="body2" fontWeight={700}>
                    No asignados
                  </Typography>
                  <Chip size="small" label={summary.UNASSIGNED || 0} color="info" variant={activeTab === 'UNASSIGNED' ? 'filled' : 'outlined'} />
                </Stack>
              }
              sx={(theme) => ({
                mx: 0.5,
                borderRadius: 2,
                textTransform: 'none',
                fontWeight: 700,
                color: theme.palette.text.primary,
                backgroundColor: activeTab === 'UNASSIGNED' ? theme.semanticColors.surfaceHover : 'transparent',
                '& .MuiChip-root': {
                  bgcolor: activeTab === 'UNASSIGNED' ? theme.palette.primary.main : theme.semanticColors.surface
                },
                ...(activeTab === 'UNASSIGNED'
                  ? { color: theme.palette.primary.dark }
                  : { '&:hover': { backgroundColor: theme.semanticColors.surfaceHover } })
              })}
            />
          )}
          <Tab
            value="OPEN"
            label={
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Typography variant="body2" fontWeight={700}>
                  Asignados
                </Typography>
                <Chip size="small" label={summary.OPEN || 0} color="primary" variant={activeTab === 'OPEN' ? 'filled' : 'outlined'} />
              </Stack>
            }
            sx={(theme) => ({
              mx: 0.5,
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 700,
              color: theme.palette.text.primary,
              backgroundColor: activeTab === 'OPEN' ? theme.semanticColors.surfaceHover : 'transparent',
              ...(activeTab === 'OPEN'
                ? { color: theme.palette.primary.dark }
                : { '&:hover': { backgroundColor: theme.semanticColors.surfaceHover } })
            })}
          />
          {role !== 'AGENTE' && (
            <Tab
              value="CLOSED"
              label={
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Typography variant="body2" fontWeight={700}>
                    Cerrados
                  </Typography>
                  <Chip size="small" label={summary.CLOSED || 0} color={activeTab === 'CLOSED' ? 'primary' : 'default'} variant={activeTab === 'CLOSED' ? 'filled' : 'outlined'} />
                </Stack>
              }
              sx={(theme) => ({
                mx: 0.5,
                borderRadius: 2,
                textTransform: 'none',
                fontWeight: 700,
                color: theme.palette.text.primary,
                backgroundColor: activeTab === 'CLOSED' ? theme.semanticColors.surfaceHover : 'transparent',
                ...(activeTab === 'CLOSED'
                  ? { color: theme.palette.primary.dark }
                  : { '&:hover': { backgroundColor: theme.semanticColors.surfaceHover } })
              })}
            />
          )}
        </Tabs>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center" sx={{ width: '100%', justifyContent: 'flex-end' }}>
          <TextField
            size="small"
            placeholder="Buscar por número o texto"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }}
            sx={{ minWidth: { xs: '100%', md: 220 } }}
          />
          {(role === 'ADMIN' || role === 'SUPERVISOR') && (
            <>
              <Autocomplete
                multiple
                size="small"
                options={queueFilterOptions}
                value={queueFilterOptions.filter((opt) => queueFilter.includes(opt.id))}
                onChange={(_e, val) => setQueueFilter(val.map((v) => v.id))}
                getOptionLabel={(option) => option.name || ''}
                isOptionEqualToValue={(opt, val) => opt.id === val.id}
                sx={{ minWidth: { xs: '100%', md: 180 } }}
                renderInput={(params) => <TextField {...params} label="Filtrar por cola" placeholder="Colas" />}
              />
              <Autocomplete
                multiple
                size="small"
                options={userFilterOptions}
                value={userFilterOptions.filter((opt) => userFilter.includes(opt.id))}
                onChange={(_e, val) => setUserFilter(val.map((v) => v.id))}
                getOptionLabel={(option) => option.name || ''}
                isOptionEqualToValue={(opt, val) => opt.id === val.id}
                sx={{ minWidth: { xs: '100%', md: 200 } }}
                renderOption={(props, option) => (
                  <Box component="li" {...props} key={option.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Avatar src={option.avatar || undefined} alt={option.name} sx={{ width: 28, height: 28 }}>
                      {(option.name || 'U')?.[0]?.toUpperCase()}
                    </Avatar>
                    <Typography variant="body2">{option.name}</Typography>
                  </Box>
                )}
                renderInput={(params) => <TextField {...params} label="Filtrar por usuario" placeholder="Agentes" />}
              />
            </>
          )}
          <Button
            variant="contained"
            startIcon={<AddCircleOutlineIcon />}
            onClick={openNewChatModal}
            disabled={newChatLoading}
          >
            Nuevo Chat
          </Button>
        </Stack>
      </Stack>
      <Box
        sx={(theme) => ({
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '320px 1fr' },
          gap: 0,
          height: '75vh',
          minHeight: 0,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 3,
          overflow: 'hidden',
          backgroundColor: theme.semanticColors.surfaceSecondary
        })}
      >
        {loading ? (
          <Box sx={{ display: 'grid', placeItems: 'center' }}>
            <CircularProgress />
          </Box>
        ) : (
          <ChatInbox
            chats={filteredChats}
            activeId={activeChatId}
            unreadCounts={unread}
            onSelect={(c) => setActiveChatId(c.id)}
            onRefresh={loadChats}
            hasMore={Boolean(chatCursor)}
            loadingMore={loadingMoreChats}
            onLoadMore={() => loadChats(true)}
          />
        )}
        <ChatWindow
          chat={activeChat}
          userId={user?.id}
          messages={messages[activeChatId] || []}
          onSend={handleSend}
          sending={false}
          loadingMessages={loadingMsgs}
          role={role}
          onDeleteMessage={handleDeleteMessage}
          onAssignToMe={
            role === 'ADMIN' || role === 'SUPERVISOR'
              ? handleAssignToMe
              : activeChat && !activeChat.assignedUserId
              ? handleAssignToMe
              : undefined
          }
          onReassign={canOpenReassign ? () => setShowReassign(true) : undefined}
          onCloseChat={activeChat ? handleCloseChat : undefined}
          quickReplyApi={quickReplyApi}
          onOpenContact={activeChat ? handleOpenContactModal : undefined}
          chatPanelProps={{
            hasMore: hasMoreMap[activeChatId] || false,
            loadingMore: messagesLoadingMap[activeChatId] || false,
            onLoadMore: handleLoadMoreMessages,
            autoScrollKey: scrollKey
          }}
        />
      </Box>
      <ContactInfoModal
        open={contactModalOpen}
        onClose={() => (!contactSaving ? setContactModalOpen(false) : null)}
        contact={activeContact}
        chat={activeChat}
        avatarUrl={contactModalAvatar}
        onSave={handleSaveContact}
        loading={contactSaving}
        error={contactModalError}
      />
      <Dialog open={newChatOpen} onClose={() => (!newChatLoading ? setNewChatOpen(false) : null)} fullWidth maxWidth="sm">
        <DialogTitle>Nuevo Chat</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Autocomplete
              size="small"
              options={COUNTRY_OPTIONS}
              value={selectedCountry}
              onChange={(_e, val) =>
                setNewChatForm((prev) => ({
                  ...prev,
                  countryCode: val?.code || prev.countryCode
                }))
              }
              getOptionLabel={(opt) => opt.label}
              isOptionEqualToValue={(opt, val) => opt.code === val.code}
              renderInput={(params) => <TextField {...params} label="País" placeholder="Selecciona el país" />}
            />

            <FormControl fullWidth disabled={connectionsLoading || availableConnections.length === 0} size="small">
              <InputLabel id="new-chat-connection-label" shrink>
                Conexión WhatsApp
              </InputLabel>
              <Select
                labelId="new-chat-connection-label"
                label="Conexión WhatsApp"
                value={newChatForm.sessionName}
                onChange={(e) => {
                  const sessionName = e.target.value;
                  const selected = availableConnections.find((c) => c.name === sessionName);
                  const selectedQueues = selected?.queues || [];
                  setNewChatForm((prev) => {
                    const keepQueue = prev.queueId && selectedQueues.some((q) => q.id === prev.queueId);
                    const queueId = keepQueue ? prev.queueId : selectedQueues.length === 1 ? selectedQueues[0].id : '';
                    return { ...prev, sessionName, queueId };
                  });
                }}
                displayEmpty
                renderValue={(val) =>
                  val ? (
                    val
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Selecciona una conexión asignada
                    </Typography>
                  )
                }
              >
                {availableConnections.length === 0 && (
                  <MenuItem value="" disabled>
                    Sin conexiones asignadas a tus colas
                  </MenuItem>
                )}
                {availableConnections.map((c) => (
                  <MenuItem key={c.name} value={c.name}>
                    {c.name} {c.status ? `(${c.status})` : ''}
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText sx={{ minHeight: 20, lineHeight: 1.2 }}>
                {connectionsLoading
                  ? 'Cargando conexiones asignadas...'
                  : availableConnections.length && !connectedConnections.length
                    ? 'No hay conexiones en estado conectado; espera a que alguna se conecte.'
                    : availableConnections.length
                      ? 'Solo conexiones asignadas por colas'
                      : 'Solicita asignación de cola para crear chats'}
              </FormHelperText>
            </FormControl>
            <FormControl
              fullWidth
              disabled={connectionsLoading || !newChatForm.sessionName || connectionQueues.length === 0}
              size="small"
            >
              <InputLabel id="new-chat-queue-label" shrink>
                Cola
              </InputLabel>
              <Select
                labelId="new-chat-queue-label"
                label="Cola"
                value={newChatForm.queueId}
                onChange={(e) => setNewChatForm((prev) => ({ ...prev, queueId: e.target.value }))}
                displayEmpty
                renderValue={(val) =>
                  val ? (
                    connectionQueues.find((q) => q.id === val)?.name || 'Cola seleccionada'
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Selecciona una cola
                    </Typography>
                  )
                }
              >
                {connectionQueues.length === 0 && (
                  <MenuItem value="" disabled>
                    Sin colas disponibles para esta conexión
                  </MenuItem>
                )}
                {connectionQueues.map((q) => (
                  <MenuItem key={q.id} value={q.id}>
                    {q.name}
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText sx={{ minHeight: 20, lineHeight: 1.2 }}>
                {connectionQueues.length === 0
                  ? 'Asigna la conexión a alguna cola antes de crear chat'
                  : 'Solo se listan las colas asociadas a esta conexión'}
              </FormHelperText>
            </FormControl>
            <TextField
              size="small"
              label="Contacto (número)"
              placeholder="5512345678"
              value={newChatForm.contact}
              onChange={(e) => setNewChatForm((prev) => ({ ...prev, contact: e.target.value }))}
              helperText={`Se normaliza con el prefijo +${selectedCountry.code || ''}`}
              InputProps={{
                startAdornment: <InputAdornment position="start">+{selectedCountry.code}</InputAdornment>
              }}
            />
            {hasOpenChatForContact(newChatForm.sessionName, newChatContactValue) && (
              <Alert severity="warning">Ya existe un chat activo para este contacto en esta conexión</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewChatOpen(false)} disabled={newChatLoading}>
            Cancelar
          </Button>
          <Button
            variant="contained"
            onClick={handleCreateChat}
            disabled={
              newChatLoading ||
              !newChatForm.sessionName.trim() ||
              !newChatForm.contact.trim() ||
              !newChatForm.queueId
            }
          >
            {newChatLoading ? 'Procesando...' : 'Crear'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(deleteTarget)} onClose={() => (!moderating.delete ? setDeleteTarget(null) : null)} fullWidth maxWidth="xs">
        <DialogTitle>Eliminar mensaje para el cliente</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            El mensaje se eliminará para el cliente en WhatsApp, pero seguirá visible para auditoría. ¿Confirmas?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={moderating.delete}>
            Cancelar
          </Button>
          <Button onClick={confirmDeleteMessage} color="error" variant="contained" disabled={moderating.delete}>
            {moderating.delete ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={Boolean(snackbar)} autoHideDuration={4000} onClose={() => setSnackbar(null)}>
        {snackbar && (
          <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>
            {snackbar.message}
          </Alert>
        )}
      </Snackbar>
      <ReassignModal
        open={showReassign}
        onClose={() => setShowReassign(false)}
        chat={activeChat}
        agents={agents}
        connections={connections}
        role={role}
        onConfirm={async ({ toAgentId, sessionName, reason }) => {
          if (!activeChatId) return;
          try {
            const updated = await chatService.reassignChat(activeChatId, { toAgentId, sessionName, reason });
            const keepVisible = handleReassignSuccess(updated);
            setShowReassign(false);
            if (keepVisible) {
              await loadMessages(updated.id);
            }
          } catch (err) {
            handleError(err, { source: 'reassign_chat' });
          }
        }}
        loading={loading || loadingMsgs}
      />
    </PageLayout>
  );
};

export default ChatView;
