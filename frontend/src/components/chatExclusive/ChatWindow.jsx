import { useEffect, useRef, useState, useMemo } from 'react';
import {
  Box,
  Divider,
  Stack,
  Typography,
  Chip,
  Button,
  Avatar
} from '@mui/material';
import { alpha } from '@mui/material/styles';

import MessageBubble from './MessageBubble.jsx';
import MessageInput from './MessageInput.jsx';
import ChatPanel from './ChatPanel.jsx';
import ImagePreviewModal from './ImagePreviewModal.jsx';
import VideoPreviewModal from './VideoPreviewModal.jsx';
import QuickReplyComposer from './QuickReplyComposer.jsx';
import QuickReplySuggestions from './QuickReplySuggestions.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { getWhatsAppStatusColor, normalizeWhatsAppStatus } from '../../utils/whatsappStatus.js';

/* =========================
   CONSTANTES
========================= */
const MAX_MB = 6;
const MAX_RECORD_SECONDS = 60;

const ALLOWED_TYPES = [
  'image/',
  'video/',
  'audio/',
  'audio/webm',
  'audio/ogg',
  'application/pdf'
];

const statusBg = (theme, status) => {
  switch (status) {
    case 'OPEN':
    case 'ASSIGNED':
      return theme.semanticColors.surfaceHover;
    case 'UNASSIGNED':
      return theme.semanticColors.surfaceSecondary;
    case 'CLOSED':
      return theme.palette.action.hover;
    case 'BLOCKED':
      return alpha(theme.palette.error.main, 0.08);
    default:
      return theme.semanticColors.surfaceSecondary;
  }
};

/* =========================
   COMPONENTE
========================= */
const ChatWindow = ({
  chat,
  userId,
  messages = [],
  onSend,
  onAssignToMe,
  sending = false,
  role,
  onReassign,
  onCloseChat,
  loadingMessages = false,
  onDeleteMessage,
  chatPanelProps = {},
  quickReplyApi = {},
  onOpenContact
}) => {
  /* =========================
     STATE
  ========================== */
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [preview, setPreview] = useState({ open: false, url: null, type: null });

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState(null);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const stopTimeoutRef = useRef(null);

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordUrl, setRecordUrl] = useState(null);
  const [recordError, setRecordError] = useState(null);

  const [quickReplyDraft, setQuickReplyDraft] = useState(null);
  const [quickReplyValues, setQuickReplyValues] = useState({});
  const [qrSuggestions, setQrSuggestions] = useState([]);
  const [qrQuery, setQrQuery] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const { token } = useAuth();
  const avatarCache = useRef(new Map());
  const [resolvedAvatar, setResolvedAvatar] = useState(null);
  const contactName =
    chat?.remoteName ||
    chat?.contactDisplayName ||
    chat?.contactName ||
    chat?.pushName ||
    chat?.remoteNumber ||
    'Contacto';
  const contactAvatar =
    chat?.contactAvatar ||
    chat?.remoteAvatar ||
    chat?.remote_avatar ||
    chat?.remoteProfilePic ||
    chat?.remote_profile_pic ||
    chat?.remoteProfilePicUrl ||
    chat?.remote_profile_pic_url ||
    chat?.profilePic ||
    chat?.profile_pic ||
    chat?.profilePicUrl ||
    chat?.profile_pic_url ||
    chat?.avatar ||
    null;
  const quickReplyCacheRef = useRef(new Map());
  const qrTimerRef = useRef(null);
  const [sendingQuickReply, setSendingQuickReply] = useState(false);
  const connectionName = chat?.whatsappSessionName || chat?.whatsapp_session_name || 'Sin conexion';
  const connectionStatus = normalizeWhatsAppStatus(chat?.whatsappStatus || chat?.whatsapp_status, 'unknown');

  useEffect(() => {
    setQuickReplyDraft(null);
    setQuickReplyValues({});
    setQrSuggestions([]);
    setQrQuery('');
    setText('');
    setFiles([]);
  }, [chat?.id]);

  useEffect(() => {
    const resolveAvatar = async () => {
      if (!contactAvatar) {
        setResolvedAvatar(null);
        return;
      }
      const urlObj = new URL(contactAvatar, window.location.origin);
      if (!urlObj.pathname.startsWith('/api/v1/media')) {
        setResolvedAvatar(contactAvatar);
        return;
      }
      const key = contactAvatar;
      const cached = avatarCache.current.get(key);
      if (cached) {
        setResolvedAvatar(cached);
        return;
      }
      if (!token) {
        setResolvedAvatar(null);
        return;
      }
      const path = urlObj.searchParams.get('path');
      const sig = urlObj.searchParams.get('sig');
      const exp = urlObj.searchParams.get('exp');
      const sha = urlObj.searchParams.get('sha');
      if (!path) {
        setResolvedAvatar(null);
        return;
      }
      try {
        const resp = await fetch('/api/v1/media/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ path, sig, exp, sha })
        });
        if (!resp.ok) throw new Error('media fetch failed');
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        avatarCache.current.set(key, objectUrl);
        setResolvedAvatar(objectUrl);
      } catch (_err) {
        setResolvedAvatar(null);
      }
    };
    resolveAvatar();
  }, [contactAvatar, token]);

  const handleOpenContact = () => {
    onOpenContact?.({ avatarUrl: resolvedAvatar || contactAvatar || null });
  };

  /* =========================
     PERMISOS
  ========================== */
  const permissions = useMemo(() => {
    if (!chat) return { canSend: false, reason: 'Selecciona un chat' };

    const isAgent = role === 'AGENTE';
    const isSupervisor = role === 'SUPERVISOR' || role === 'ADMIN';
    const isClosed = chat.status === 'CLOSED';
    const isMine =
      userId &&
      (chat.assignedUserId === userId ||
        chat.assignedAgentId === userId);

    if (isAgent) {
      if (chat.status !== 'OPEN') {
        return { canSend: false, reason: 'Chat no está abierto' };
      }
      if (!isMine) {
        return { canSend: false, reason: 'Chat no asignado a ti' };
      }
      return { canSend: true };
    }

    if (isSupervisor) {
      return { canSend: true };
    }

    return { canSend: false, reason: 'Sin permisos' };
  }, [chat, role, userId]);

  const canModerateMessages = useMemo(() => {
    if (!chat) return false;
    if (role === 'ADMIN' || role === 'SUPERVISOR') return true;
    if (role === 'AGENTE') {
      return chat.assignedAgentId === userId || chat.assignedUserId === userId;
    }
    return false;
  }, [chat, role, userId]);

  /* =========================
     HELPERS
  ========================== */
  const cleanupRecordingPreview = () => {
    if (recordUrl) URL.revokeObjectURL(recordUrl);
    setRecordUrl(null);
  };

  const validateFiles = (selected) => {
    for (const f of selected) {
      if (f.size > MAX_MB * 1024 * 1024) {
        setError(`El archivo supera ${MAX_MB}MB`);
        return false;
      }
      if (!ALLOWED_TYPES.some((t) => f.type?.startsWith(t))) {
        setError(`Tipo no permitido (${f.type})`);
        return false;
      }
    }
    setError(null);
    return true;
  };

  const handleTextChange = (value) => {
    if (quickReplyDraft) return;
    setError(null);
    setText(value);
    if (value.startsWith('/')) {
      const query = value.slice(1).trim();
      setQrQuery(query);
    } else {
      setQrQuery('');
      setQrSuggestions([]);
    }
  };

  useEffect(() => {
    if (!text.startsWith('/')) {
      setQrLoading(false);
      setQrSuggestions([]);
      return;
    }
    if (!quickReplyApi?.search) return;
    if (qrTimerRef.current) clearTimeout(qrTimerRef.current);
    setQrLoading(true);
    const key = (qrQuery || '_all').toLowerCase();
    qrTimerRef.current = setTimeout(async () => {
      if (quickReplyCacheRef.current.has(key)) {
        setQrSuggestions(quickReplyCacheRef.current.get(key));
        setQrLoading(false);
        return;
      }
      try {
        const results = await quickReplyApi.search(qrQuery);
        const normalized = Array.isArray(results) ? results : [];
        quickReplyCacheRef.current.set(key, normalized);
        setQrSuggestions(normalized);
      } catch (_) {
        setQrSuggestions([]);
      } finally {
        setQrLoading(false);
      }
    }, 220);
    return () => clearTimeout(qrTimerRef.current);
  }, [qrQuery, quickReplyApi, text]);

  const handleSelectQuickReply = (item) => {
    if (!item) return;
    setError(null);
    const vars = (item.variables || []).reduce((acc, v) => ({ ...acc, [v]: '' }), {});
    setQuickReplyDraft(item);
    setQuickReplyValues(vars);
    setText('');
    setFiles([]);
    setQrSuggestions([]);
    setQrQuery('');
  };

  const handleQuickReplyValueChange = (name, value) => {
    setQuickReplyValues((prev) => ({ ...prev, [name]: value }));
  };

  const quickReplyReady =
    quickReplyDraft &&
    (quickReplyDraft.variables || []).every((v) => (quickReplyValues?.[v] || '').trim().length > 0);

  /* =========================
     ENVÍO
  ========================== */
  const handleSend = async () => {
    if (quickReplyDraft) {
      if (!quickReplyReady) {
        setError('Completa las variables obligatorias');
        return;
      }
      if (!quickReplyApi?.send) {
        setError('Respuestas rápidas no disponibles');
        return;
      }
      try {
        setSendingQuickReply(true);
        await quickReplyApi.send({ quickReplyId: quickReplyDraft.id, variables: quickReplyValues });
        setQuickReplyDraft(null);
        setQuickReplyValues({});
        setText('');
        setFiles([]);
      } catch (err) {
        setError(err?.message || 'No se pudo enviar');
      } finally {
        setSendingQuickReply(false);
      }
      return;
    }

    if (text.trim().startsWith('/')) {
      setError('Selecciona una respuesta rápida antes de enviar');
      return;
    }

    const payload = { text: text.trim() };

    if (files.length) {
      if (!validateFiles(files)) return;
      payload.file = files[0];
    }

    if (!payload.text && !payload.file) return;

    payload.onProgress = (p) =>
      typeof p === 'number' && setUploadProgress(p);

    try {
      setUploading(true);
      setUploadProgress(0);

      await onSend?.(payload);

      setText('');
      setFiles([]);
      cleanupRecordingPreview();
      setUploadProgress(100);
    } catch (err) {
      setError(err?.message || 'No se pudo enviar');
    } finally {
      setUploading(false);
      setTimeout(() => setUploadProgress(0), 300);
    }
  };

  /* =========================
     GRABACIÓN AUDIO
  ========================== */
  const stopRecording = () => {
    try {
      recorderRef.current?.stop();
      recorderRef.current?.stream
        ?.getTracks()
        .forEach((t) => t.stop());
    } catch (_) {}

    clearInterval(recordTimerRef.current);
    clearTimeout(stopTimeoutRef.current);

    recorderRef.current = null;
    setRecording(false);
    setRecordSeconds(0);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordError('Grabación no soportada');
      return;
    }

    try {
      setRecordError(null);
      cleanupRecordingPreview();
      setFiles([]);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      chunksRef.current = [];

      recorder.ondataavailable = (e) =>
        e.data.size && chunksRef.current.push(e.data);

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType
        });
        if (!blob.size) return;

        const file = new File(
          [blob],
          `voice-${Date.now()}.webm`,
          { type: recorder.mimeType }
        );

        setRecordUrl(URL.createObjectURL(blob));
        setFiles([file]);
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);

      recordTimerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );

      stopTimeoutRef.current = setTimeout(
        stopRecording,
        MAX_RECORD_SECONDS * 1000
      );
    } catch (err) {
      setRecordError(err?.message || 'Error al grabar');
      stopRecording();
    }
  };

  useEffect(() => {
    return () => {
      stopRecording();
      cleanupRecordingPreview();
    };
  }, []);

  /* =========================
     EMPTY
  ========================== */
  if (!chat) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <Typography color="text.secondary">
          Selecciona un chat
        </Typography>
      </Box>
    );
  }

  const footer = quickReplyDraft ? (
    <QuickReplyComposer
      template={quickReplyDraft}
      values={quickReplyValues}
      onChangeValue={handleQuickReplyValueChange}
      onCancel={() => {
        setQuickReplyDraft(null);
        setQuickReplyValues({});
        setText('');
      }}
      onSend={handleSend}
      sending={sendingQuickReply || sending}
      disabled={!permissions.canSend}
    />
  ) : (
    <Box sx={{ position: 'relative' }}>
      <MessageInput
        text={text}
        onTextChange={handleTextChange}
        attachments={files}
        onRemoveAttachment={(i) =>
          setFiles((prev) => prev.filter((_, idx) => idx !== i))
        }
        onFilesSelected={(f) => validateFiles(f) && setFiles(f)}
        onSend={handleSend}
        disabled={!permissions.canSend || sending || sendingQuickReply}
        disabledReason={permissions.reason}
        uploading={uploading}
        uploadProgress={uploadProgress}
        error={error}
        recordError={recordError}
        recording={recording}
        recordSeconds={recordSeconds}
        onToggleRecording={
          recording ? stopRecording : startRecording
        }
        recordPreviewUrl={recordUrl}
        onCancelRecording={cleanupRecordingPreview}
        maxMb={MAX_MB}
      />
      <QuickReplySuggestions
        open={text.startsWith('/') && !quickReplyDraft}
        query={qrQuery}
        suggestions={qrSuggestions}
        loading={qrLoading}
        onSelect={handleSelectQuickReply}
      />
    </Box>
  );

  /* =========================
     RENDER
  ========================== */
  return (
    <Box
      sx={(theme) => ({
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        bgcolor: theme.semanticColors.surface
      })}
    >
      {/* ============ HEADER ============ */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={2}
        sx={(theme) => ({
          px: 2,
          py: 1,
          borderBottom: `1px solid ${theme.palette.divider}`,
          bgcolor: statusBg(theme, chat.status)
        })}
      >
        <Box onClick={handleOpenContact} sx={{ cursor: onOpenContact ? 'pointer' : 'default' }}>
          <Avatar
            src={resolvedAvatar || undefined}
            alt={contactName}
            sx={(theme) => ({
              width: 40,
              height: 40,
              bgcolor: contactAvatar ? theme.palette.background.paper : theme.palette.primary.light,
              color: contactAvatar ? theme.palette.text.primary : theme.palette.primary.contrastText,
              fontWeight: 700,
              border: `1px solid ${theme.palette.divider}`
            })}
          >
            {contactName?.[0]?.toUpperCase() || 'C'}
          </Avatar>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={700} noWrap>
            {contactName}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary" noWrap>
              {chat.remoteNumber || 'Sin número'}
            </Typography>
            <Chip
              size="small"
              label={connectionName}
              color={getWhatsAppStatusColor(connectionStatus)}
              variant="outlined"
            />
            <Typography variant="caption" color="text.secondary">
              {chat.queueName || 'Sin cola'} · {chat.assignedUserName || chat.assignedAgentName || 'Sin asignar'}
            </Typography>
          </Stack>
        </Box>

        <Box sx={{ flex: 1 }} />

        {/* Acciones */}
        <Stack direction="row" spacing={1}>
          {onAssignToMe &&
            chat.status !== 'CLOSED' &&
            permissions.canSend === false && (
              <Button size="small" variant="outlined" onClick={onAssignToMe}>
                Tomar
              </Button>
            )}

          {onReassign && (
            <Button size="small" variant="contained" onClick={onReassign}>
              {role === 'AGENTE' ? 'Transferir' : 'Reasignar'}
            </Button>
          )}

          {onCloseChat && chat.status !== 'CLOSED' && (
            <Button
              size="small"
              variant="outlined"
              color="error"
              onClick={onCloseChat}
            >
              Cerrar
            </Button>
          )}
        </Stack>
      </Stack>

      <Divider />

      {/* ============ CHAT PANEL ============ */}
      <ChatPanel
        messages={messages}
        loading={loadingMessages}
        {...chatPanelProps}
        renderMessage={(m) => (
          <MessageBubble
            key={m.id || m.whatsappMessageId}
            message={m}
            onPreview={(p) =>
              setPreview({ open: true, ...p })
            }
            onDelete={canModerateMessages ? () => onDeleteMessage?.(m) : undefined}
          />
        )}
        footer={footer}
      />

      {/* ============ MODALES ============ */}
      <ImagePreviewModal
        open={preview.open && preview.type === 'image'}
        url={preview.url}
        onClose={() =>
          setPreview({ open: false, url: null, type: null })
        }
      />
      <VideoPreviewModal
        open={preview.open && preview.type === 'video'}
        url={preview.url}
        onClose={() =>
          setPreview({ open: false, url: null, type: null })
        }
      />
    </Box>
  );
};

export default ChatWindow;
