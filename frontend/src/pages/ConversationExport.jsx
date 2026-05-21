import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  LinearProgress,
  List,
  ListItemButton,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchIcon from '@mui/icons-material/Search';
import DownloadIcon from '@mui/icons-material/Download';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import DeselectIcon from '@mui/icons-material/DisabledByDefault';
import PhoneIcon from '@mui/icons-material/Phone';

import PageLayout from '../components/PageLayout.jsx';
import createChatService from '../services/chat.service.js';
import { useAuth } from '../context/AuthContext.jsx';
import { normalizePhoneNumber } from '../utils/phone.js';
import {
  exportWhatsAppScreenshotsZip,
  formatExportDate,
  getExportMessageKey,
  getExportMessageText
} from '../utils/whatsappExport.js';

const statusColor = {
  OPEN: 'primary',
  UNASSIGNED: 'info',
  CLOSED: 'default'
};

const getChatTitle = (chat) =>
  chat?.contactName ||
  chat?.pushName ||
  chat?.remoteName ||
  chat?.contactDisplayName ||
  chat?.remoteNumber ||
  'Contacto';

const getMessageDate = (message) => message?.timestamp || message?.createdAt || message?.updatedAt || null;

const formatTime = (value) => {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

const selectedCountForChat = (selectedMap = {}) => Object.values(selectedMap).filter(Boolean).length;

const buildSelectionMap = (messages = [], selected = true) =>
  messages.reduce((acc, message) => {
    acc[getExportMessageKey(message)] = selected;
    return acc;
  }, {});

const ConversationExport = () => {
  const { token, logout } = useAuth();
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

  const [phone, setPhone] = useState('');
  const [conversations, setConversations] = useState([]);
  const [messagesByChat, setMessagesByChat] = useState({});
  const [selectedByChat, setSelectedByChat] = useState({});
  const [activeChatId, setActiveChatId] = useState(null);
  const [messageFilter, setMessageFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('');
  const [exporting, setExporting] = useState(false);
  const [snackbar, setSnackbar] = useState(null);

  const activeChat = useMemo(
    () => conversations.find((conversation) => conversation.id === activeChatId) || null,
    [conversations, activeChatId]
  );

  const activeMessages = useMemo(() => {
    const messages = messagesByChat[activeChatId] || [];
    const term = messageFilter.trim().toLowerCase();
    if (!term) return messages;
    return messages.filter((message) => getExportMessageText(message).toLowerCase().includes(term));
  }, [activeChatId, messageFilter, messagesByChat]);

  const totalMessages = useMemo(
    () => Object.values(messagesByChat).reduce((sum, messages) => sum + messages.length, 0),
    [messagesByChat]
  );

  const selectedMessagesCount = useMemo(
    () => Object.values(selectedByChat).reduce((sum, selectedMap) => sum + selectedCountForChat(selectedMap), 0),
    [selectedByChat]
  );

  const loadAllMessages = useCallback(
    async (chat) => {
      let cursor = null;
      const messages = [];
      do {
        const data = await chatService.getMessages(chat.id, { limit: 200, cursor });
        messages.push(...(data.messages || []));
        cursor = data.nextCursor;
      } while (cursor);

      return messages.sort((a, b) => new Date(getMessageDate(a) || 0) - new Date(getMessageDate(b) || 0));
    },
    [chatService]
  );

  const handleSearch = async () => {
    const digits = normalizePhoneNumber(phone);
    if (digits.length < 6) {
      setSnackbar({ severity: 'warning', message: 'Ingresa un teléfono válido.' });
      return;
    }

    setLoading(true);
    setLoadingLabel('Buscando conversaciones');
    setConversations([]);
    setMessagesByChat({});
    setSelectedByChat({});
    setActiveChatId(null);
    setMessageFilter('');

    try {
      const result = await chatService.findChatsByPhoneForExport({ phone: digits, limit: 100 });
      const items = result?.items || [];
      setConversations(items);

      const nextMessagesByChat = {};
      const nextSelectedByChat = {};

      for (let index = 0; index < items.length; index += 1) {
        const chat = items[index];
        setLoadingLabel(`Cargando mensajes ${index + 1}/${items.length}`);
        const messages = await loadAllMessages(chat);
        nextMessagesByChat[chat.id] = messages;
        nextSelectedByChat[chat.id] = buildSelectionMap(messages, true);
      }

      setMessagesByChat(nextMessagesByChat);
      setSelectedByChat(nextSelectedByChat);
      setActiveChatId(items[0]?.id || null);
      setSnackbar({
        severity: items.length ? 'success' : 'info',
        message: items.length ? 'Conversaciones listas para exportar.' : 'No se encontraron conversaciones para ese teléfono.'
      });
    } catch (err) {
      setSnackbar({ severity: 'error', message: err?.message || 'No se pudo buscar el teléfono.' });
    } finally {
      setLoading(false);
      setLoadingLabel('');
    }
  };

  const handleToggleMessage = (chatId, message, checked) => {
    const key = getExportMessageKey(message);
    setSelectedByChat((prev) => ({
      ...prev,
      [chatId]: {
        ...(prev[chatId] || {}),
        [key]: checked
      }
    }));
  };

  const handleSelectChatMessages = (chatId, checked) => {
    const messages = messagesByChat[chatId] || [];
    setSelectedByChat((prev) => ({
      ...prev,
      [chatId]: buildSelectionMap(messages, checked)
    }));
  };

  const handleSelectAll = (checked) => {
    const next = {};
    conversations.forEach((chat) => {
      next[chat.id] = buildSelectionMap(messagesByChat[chat.id] || [], checked);
    });
    setSelectedByChat(next);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const files = await exportWhatsAppScreenshotsZip({
        conversations,
        messagesByChat,
        selectedByChat,
        phone: normalizePhoneNumber(phone)
      });
      setSnackbar({ severity: 'success', message: `ZIP generado con ${files} captura(s).` });
    } catch (err) {
      setSnackbar({ severity: 'error', message: err?.message || 'No se pudo generar el ZIP.' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageLayout
      title="Exportar conversaciones"
      subtitle="Busca por teléfono, marca los mensajes y descarga capturas tipo WhatsApp."
      actions={
        <Button
          startIcon={exporting ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
          onClick={handleExport}
          disabled={!selectedMessagesCount || exporting || loading}
        >
          Exportar ZIP
        </Button>
      }
    >
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', md: 'center' }}>
          <TextField
            label="Teléfono"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSearch();
            }}
            placeholder="521..."
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <PhoneIcon fontSize="small" />
                </InputAdornment>
              )
            }}
            sx={{ minWidth: { xs: '100%', md: 320 } }}
          />
          <Button
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <SearchIcon />}
            onClick={handleSearch}
            disabled={loading || exporting}
          >
            Buscar
          </Button>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Chip size="small" label={`${conversations.length} conversaciones`} variant="outlined" />
            <Chip size="small" label={`${selectedMessagesCount}/${totalMessages} mensajes`} variant="outlined" />
          </Stack>
        </Stack>

        {loading && (
          <Box>
            <LinearProgress />
            <Typography variant="caption" color="text.secondary">
              {loadingLabel}
            </Typography>
          </Box>
        )}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: '360px minmax(0, 1fr)' },
            gap: 2,
            alignItems: 'start'
          }}
        >
          <Box
            sx={(theme) => ({
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 2,
              bgcolor: theme.semanticColors.surface,
              minHeight: 360,
              overflow: 'hidden'
            })}
          >
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.5, py: 1 }}>
              <Typography variant="subtitle1">Conversaciones</Typography>
              <Stack direction="row" spacing={0.5}>
                <Tooltip title="Seleccionar todo">
                  <IconButton size="small" onClick={() => handleSelectAll(true)} disabled={!conversations.length}>
                    <SelectAllIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Quitar selección">
                  <IconButton size="small" onClick={() => handleSelectAll(false)} disabled={!conversations.length}>
                    <DeselectIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Stack>
            <Divider />
            <List disablePadding sx={{ maxHeight: { xs: 320, lg: 620 }, overflowY: 'auto' }}>
              {conversations.map((chat) => {
                const messageCount = messagesByChat[chat.id]?.length || 0;
                const selectedCount = selectedCountForChat(selectedByChat[chat.id]);
                return (
                  <ListItemButton
                    key={chat.id}
                    selected={chat.id === activeChatId}
                    onClick={() => setActiveChatId(chat.id)}
                    sx={{ alignItems: 'flex-start', gap: 1, py: 1.25 }}
                  >
                    <Checkbox
                      edge="start"
                      checked={messageCount > 0 && selectedCount === messageCount}
                      indeterminate={selectedCount > 0 && selectedCount < messageCount}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => handleSelectChatMessages(chat.id, event.target.checked)}
                      disabled={!messageCount}
                    />
                    <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={800} noWrap>
                          {getChatTitle(chat)}
                        </Typography>
                        <Chip size="small" color={statusColor[chat.status] || 'default'} variant="outlined" label={chat.status || 'N/A'} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {chat.whatsappSessionName || 'Sin conexión'} · {chat.queueName || 'Sin cola'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {selectedCount}/{messageCount} mensajes
                      </Typography>
                    </Stack>
                  </ListItemButton>
                );
              })}
              {!conversations.length && !loading && (
                <Box sx={{ p: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Sin resultados.
                  </Typography>
                </Box>
              )}
            </List>
          </Box>

          <Box
            sx={(theme) => ({
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 2,
              bgcolor: theme.semanticColors.surface,
              minHeight: 620,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            })}
          >
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1}
              alignItems={{ xs: 'stretch', md: 'center' }}
              justifyContent="space-between"
              sx={{ px: 1.5, py: 1 }}
            >
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Typography variant="subtitle1" noWrap>
                  {activeChat ? getChatTitle(activeChat) : 'Mensajes'}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {activeChat?.remoteNumber ? `+${activeChat.remoteNumber}` : 'Selecciona una conversación'}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  value={messageFilter}
                  onChange={(event) => setMessageFilter(event.target.value)}
                  placeholder="Filtrar mensajes"
                  disabled={!activeChat}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    )
                  }}
                  sx={{ width: { xs: '100%', md: 240 } }}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={
                        Boolean(activeChat) &&
                        (messagesByChat[activeChatId] || []).length > 0 &&
                        selectedCountForChat(selectedByChat[activeChatId]) === (messagesByChat[activeChatId] || []).length
                      }
                      indeterminate={
                        Boolean(activeChat) &&
                        selectedCountForChat(selectedByChat[activeChatId]) > 0 &&
                        selectedCountForChat(selectedByChat[activeChatId]) < (messagesByChat[activeChatId] || []).length
                      }
                      onChange={(event) => activeChat && handleSelectChatMessages(activeChat.id, event.target.checked)}
                      disabled={!activeChat}
                    />
                  }
                  label="Todo"
                />
              </Stack>
            </Stack>
            <Divider />

            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                bgcolor: '#efeae2',
                p: { xs: 1.25, md: 2 }
              }}
            >
              <Stack spacing={1.1}>
                {activeMessages.map((message) => {
                  const key = getExportMessageKey(message);
                  const mine = message.direction === 'out';
                  const checked = Boolean(selectedByChat[activeChatId]?.[key]);
                  return (
                    <Stack
                      key={key}
                      direction="row"
                      spacing={1}
                      alignItems="flex-start"
                      justifyContent={mine ? 'flex-end' : 'flex-start'}
                    >
                      {!mine && (
                        <Checkbox
                          checked={checked}
                          onChange={(event) => handleToggleMessage(activeChatId, message, event.target.checked)}
                          sx={{ bgcolor: 'rgba(255,255,255,0.6)', borderRadius: 1 }}
                        />
                      )}
                      <Box
                        sx={(theme) => ({
                          maxWidth: { xs: 'calc(100% - 54px)', md: '72%' },
                          minWidth: 180,
                          borderRadius: 1.5,
                          px: 1.5,
                          py: 1,
                          bgcolor: mine ? '#d9fdd3' : '#ffffff',
                          border: `1px solid ${mine ? alpha(theme.palette.success.main, 0.22) : alpha(theme.palette.common.black, 0.08)}`
                        })}
                      >
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {getExportMessageText(message)}
                        </Typography>
                        {message?.content?.media && (
                          <Chip
                            size="small"
                            sx={{ mt: 0.75 }}
                            label={message.content.media.fileName || message.content.media.type || 'archivo'}
                            variant="outlined"
                          />
                        )}
                        <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ mt: 0.75 }}>
                          <Typography variant="caption" color="text.secondary">
                            {formatExportDate(getMessageDate(message))}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {formatTime(getMessageDate(message))}
                          </Typography>
                        </Stack>
                      </Box>
                      {mine && (
                        <Checkbox
                          checked={checked}
                          onChange={(event) => handleToggleMessage(activeChatId, message, event.target.checked)}
                          sx={{ bgcolor: 'rgba(255,255,255,0.6)', borderRadius: 1 }}
                        />
                      )}
                    </Stack>
                  );
                })}

                {activeChat && !activeMessages.length && (
                  <Box sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.72)', borderRadius: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      Sin mensajes para mostrar.
                    </Typography>
                  </Box>
                )}
                {!activeChat && (
                  <Box sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.72)', borderRadius: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      Busca un teléfono para comenzar.
                    </Typography>
                  </Box>
                )}
              </Stack>
            </Box>
          </Box>
        </Box>
      </Stack>

      <Snackbar open={Boolean(snackbar)} autoHideDuration={3500} onClose={() => setSnackbar(null)}>
        {snackbar && (
          <Alert severity={snackbar.severity} variant="filled" onClose={() => setSnackbar(null)}>
            {snackbar.message}
          </Alert>
        )}
      </Snackbar>
    </PageLayout>
  );
};

export default ConversationExport;
