import {
  Badge,
  ListItemButton,
  Stack,
  Typography,
  Box,
  Avatar
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { normalizeWhatsAppStatus } from '../../utils/whatsappStatus.js';

const avatarCache = new Map();

const connectionPillSx = (theme, status) => {
  const palette = (() => {
    if (status === 'connected') return { bg: theme.palette.success.main, fg: theme.palette.common.white };
    if (status === 'pending') return { bg: theme.palette.info.main, fg: theme.palette.common.white };
    if (status === 'connecting' || status === 'restarting' || status === 'pairing_code') {
      return { bg: theme.palette.warning.main, fg: theme.palette.common.white };
    }
    if (status === 'invalid' || status === 'error') return { bg: theme.palette.error.main, fg: theme.palette.common.white };
    return { bg: theme.palette.action.selected, fg: theme.palette.text.secondary };
  })();

  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    maxWidth: 116,
    height: 18,
    px: 1,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    lineHeight: '18px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    bgcolor: `${palette.bg} !important`,
    color: `${palette.fg} !important`,
    border: `1px solid ${palette.bg}`,
    boxShadow: 'none'
  };
};

const ChatItem = ({ chat, selected, onSelect, unread = 0 }) => {
  const { token } = useAuth();
  const [resolvedAvatar, setResolvedAvatar] = useState(null);

  const queueLabel = chat.queueName || chat.queue || 'Sin cola';
  const agentLabel = chat.assignedUserName || 'Sin asignar';
  const connectionStatus = normalizeWhatsAppStatus(chat.whatsappStatus || chat.whatsapp_status);
  const connectionLabel = chat.whatsappSessionName || chat.whatsapp_session_name || 'Sin conexión';
  const avatarUrl =
    chat.contactAvatar ||
    chat.remoteAvatar ||
    chat.remote_avatar ||
    chat.remoteProfilePic ||
    chat.remote_profile_pic ||
    chat.profilePic ||
    chat.profile_pic ||
    chat.profilePicUrl ||
    chat.profile_pic_url ||
    chat.avatar ||
    null;
  const displayName = chat.remoteName || chat.contactDisplayName || chat.contactName || chat.remoteNumber || 'Contacto';
  const avatarLabel = displayName;

  const mediaRequest = useMemo(() => {
    if (!avatarUrl) return null;
    const url = new URL(avatarUrl, window.location.origin);
    if (!url.pathname.startsWith('/api/v1/media')) return { type: 'direct', url: avatarUrl };
    const path = url.searchParams.get('path');
    const sig = url.searchParams.get('sig');
    const exp = url.searchParams.get('exp');
    const sha = url.searchParams.get('sha');
    if (!path) return { type: 'direct', url: avatarUrl };
    return { type: 'api', key: avatarUrl, path, sig, exp, sha };
  }, [avatarUrl]);

  useEffect(() => {
    const load = async () => {
      if (!mediaRequest) {
        setResolvedAvatar(null);
        return;
      }
      if (mediaRequest.type === 'direct') {
        setResolvedAvatar(mediaRequest.url);
        return;
      }
      const cached = avatarCache.get(mediaRequest.key);
      if (cached) {
        setResolvedAvatar(cached);
        return;
      }
      if (!token) {
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
          body: JSON.stringify({
            path: mediaRequest.path,
            sig: mediaRequest.sig,
            exp: mediaRequest.exp,
            sha: mediaRequest.sha
          })
        });
        if (!resp.ok) throw new Error('media fetch failed');
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        avatarCache.set(mediaRequest.key, objectUrl);
        setResolvedAvatar(objectUrl);
      } catch (_err) {
        setResolvedAvatar(null);
      }
    };
    load();
  }, [mediaRequest, token]);

  return (
    <ListItemButton
      selected={selected}
      onClick={() => onSelect?.(chat)}
      sx={(theme) => ({
        px: 1.5,
        py: 1,
        mb: 0.5,
        borderRadius: 1.5,
        alignItems: 'center',
        border: `1px solid ${theme.palette.divider}`,
        bgcolor: theme.semanticColors.surface,
        transition: 'background-color 120ms ease, border-color 120ms ease',

        '&.Mui-selected': {
          bgcolor: alpha(theme.palette.primary.main, 0.08),
          borderColor: theme.palette.primary.main
        }
      })}
    >
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: '100%' }}>
        <Avatar
          src={resolvedAvatar || undefined}
          alt={avatarLabel}
          sx={(theme) => ({
            width: 36,
            height: 36,
            bgcolor: avatarUrl ? theme.palette.background.paper : theme.palette.primary.light,
            color: avatarUrl ? theme.palette.text.primary : theme.palette.primary.contrastText,
            fontWeight: 700,
            border: `1px solid ${theme.palette.divider}`
          })}
        >
          {avatarLabel?.[0]?.toUpperCase() || 'C'}
        </Avatar>

        {/* Contenido */}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {/* Línea 1 */}
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography
              variant="body2"
              fontWeight={600}
              noWrap
              sx={{ flex: 1 }}
            >
              {displayName}
            </Typography>

            {/* Unread */}
            {unread > 0 && (
              <Badge
                color="primary"
                badgeContent={unread}
                sx={{
                  '& .MuiBadge-badge': {
                    fontSize: 11,
                    height: 16,
                    minWidth: 16
                  }
                }}
              />
            )}

            {/* Conexión (antes status) */}
            <Box component="span" title={connectionLabel} sx={(theme) => connectionPillSx(theme, connectionStatus)}>
              {connectionLabel}
            </Box>
          </Stack>

          {/* Línea 2 */}
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
          >
            {(chat.remoteNumber || 'Sin número') + ' · ' + queueLabel + ' · ' + agentLabel}
          </Typography>

          {/* Segmento opcional */}
          {chat.metadata?.segment && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ opacity: 0.7 }}
              noWrap
            >
              {chat.metadata.segment}
            </Typography>
          )}
        </Box>
      </Stack>
    </ListItemButton>
  );
};

export default ChatItem;
