import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  Switch,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import Chip from '@mui/material/Chip';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import WhatsAppStatusBadge from './WhatsAppStatusBadge.jsx';
import { formatCountdownClock, getCountdownRemainingMs } from '../../utils/countdown.js';

const normalizeStatus = (status) => (typeof status === 'string' ? status.toLowerCase().trim() : '');
const isConnected = (s) => normalizeStatus(s.status) === 'connected';
const hasEverConnected = (s) => Boolean(s.hasConnected || s.lastConnectedAt);

const WhatsAppSessionCard = ({
  session,
  onShowQr,
  onRequestPairing,
  onReconnect,
  onRenewQr,
  onResetAuth,
  onDisconnect,
  onDelete,
  onRefresh,
  onPhoneChange,
  onToggleSyncHistory,
  countdown,
  countdownNow,
  onManageCountdown
}) => {
  const disabled = Boolean(session.loading);
  const sessionId = session.session || session.id;
  const connected = isConnected(session);
  const everConnected = hasEverConnected(session);
  const normalizedStatus = normalizeStatus(session.status);
  const waitingQr = normalizedStatus === 'pending' || normalizedStatus === 'connecting';

  const canShowQr = !connected;
  const canRenewQr = normalizedStatus === 'pending' && session.hasStoredKeys;
  const canPair = !everConnected && !connected;
  const canReconnect = everConnected && !connected;
  const canDisconnect = connected;
  const canResetAuth = !disabled; // always allow trigger unless loading

  const phoneValid = /^[0-9]{8,15}$/.test(session.phone || '');
  const syncHistory = Boolean(session.syncHistory);
  const syncStatus = session.historySyncStatus || 'idle';
  const syncLoading = Boolean(session.syncHistoryUpdating);
  const countdownRemainingMs = getCountdownRemainingMs(countdown, countdownNow);
  const countdownActive = countdownRemainingMs > 0;
  const syncStatusColor =
    syncStatus === 'running'
      ? 'warning'
      : syncStatus === 'completed'
      ? 'success'
      : syncStatus === 'error'
      ? 'error'
      : 'default';
  const lastSync = session.historySyncedAt ? new Date(session.historySyncedAt).toLocaleString() : 'Nunca';

  return (
    <Card
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        bgcolor: theme.semanticColors.surface
      })}
    >
      <CardContent>
        {/* ===================== HEADER ===================== */}
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          spacing={2}
        >
          <Box>
            <Typography variant="h6">
              Sesión: {sessionId}
            </Typography>
            <WhatsAppStatusBadge
              status={session.status}
              loading={session.loading}
            />
          </Box>

          <Button
            variant="outlined"
            size="small"
            onClick={() => onRefresh(sessionId)}
            disabled={disabled}
            aria-label="Refrescar sesión"
          >
            Refrescar
          </Button>
        </Stack>

        {/* ===================== SYNC HISTORY ===================== */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          spacing={1}
          sx={{ mt: 1 }}
        >
          <Tooltip title="Si se activa, se descargará el historial completo de chats personales." arrow>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={syncHistory}
                  onChange={(e) => onToggleSyncHistory?.(sessionId, e.target.checked)}
                  disabled={disabled || syncLoading}
                />
              }
              label="Sincronizar historial al conectar"
            />
          </Tooltip>
          <Chip label={syncHistory ? 'Activo' : 'Inactivo'} color={syncHistory ? 'success' : 'default'} size="small" />
          <Chip label={`Sync: ${syncStatus}`} color={syncStatusColor} size="small" variant="outlined" />
          <Typography variant="caption" color="text.secondary">
            Última sync: {lastSync}
          </Typography>
        </Stack>

        {/* ===================== ERROR ===================== */}
        {session.error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {session.error}
          </Alert>
        )}

        {/* ===================== PAIRING CODE ===================== */}
        {session.pairingCode?.code && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Código de emparejamiento:{' '}
            <strong>{session.pairingCode.code}</strong>
          </Alert>
        )}

        <Divider sx={{ my: 2 }} />

        {/* ===================== ACTIONS ===================== */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
        >
          <Tooltip
            title={
              countdownActive
                ? 'Editar o detener el countdown de desbloqueo'
                : 'Definir cuánto falta para que el teléfono se desbloquee'
            }
            arrow
          >
            <Button
              variant={countdownActive ? 'contained' : 'outlined'}
              color={countdownActive ? 'warning' : 'inherit'}
              startIcon={<AccessTimeIcon />}
              onClick={() => onManageCountdown?.(sessionId)}
              sx={{ minWidth: { xs: '100%', sm: 190 } }}
              aria-label={`Countdown de desbloqueo para ${sessionId}`}
            >
              {countdownActive
                ? `Desbloqueo ${formatCountdownClock(countdownRemainingMs)}`
                : 'Countdown desbloqueo'}
            </Button>
          </Tooltip>

          {canShowQr && (
            <Button
              variant="contained"
              onClick={() => onShowQr(sessionId)}
              disabled={disabled}
            >
              Ver QR
            </Button>
          )}

          {canRenewQr && (
            <Button
              variant="outlined"
              onClick={() => onRenewQr?.(sessionId)}
              disabled={disabled}
            >
              Nuevo QR
            </Button>
          )}

          {canResetAuth && (
            <Button
              variant="outlined"
              color="warning"
              onClick={() => onResetAuth?.(sessionId)}
              disabled={disabled}
            >
              Generar nuevo QR
            </Button>
          )}

          {canReconnect && (
            <Button
              variant="outlined"
              color="primary"
              onClick={() => onReconnect(sessionId)}
              disabled={disabled}
            >
              {normalizedStatus === 'connecting'
                ? 'Conectando…'
                : 'Reconectar'}
            </Button>
          )}

          {canDisconnect && (
            <Button
              variant="outlined"
              color="error"
              onClick={() => onDisconnect(sessionId)}
              disabled={disabled}
            >
              Desconectar
            </Button>
          )}

          <Button
            variant="outlined"
            color="inherit"
            onClick={() => onDelete(sessionId)}
            disabled={disabled}
          >
            Eliminar
          </Button>
        </Stack>

        {/* ===================== PAIRING ===================== */}
        {canPair && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems="center"
            sx={{ mt: 2 }}
          >
            <TextField
              label="Teléfono E.164 (sin +)"
              size="small"
              value={session.phone || ''}
              onChange={(e) =>
                onPhoneChange(sessionId, e.target.value)
              }
              error={Boolean(session.phone) && !phoneValid}
              helperText={
                session.phone && !phoneValid
                  ? 'Número inválido'
                  : 'Ej. 5215512345678'
              }
              inputProps={{
                inputMode: 'numeric',
                pattern: '[0-9]*',
                maxLength: 15
              }}
              disabled={disabled}
            />

            <Button
              variant="contained"
              onClick={() =>
                onRequestPairing(sessionId, session.phone)
              }
              disabled={disabled || !phoneValid}
            >
              Solicitar pairing code
            </Button>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
};

export default WhatsAppSessionCard;
