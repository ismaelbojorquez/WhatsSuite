import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  MenuItem,
  Select,
  Tooltip,
  Typography,
  Alert,
  CircularProgress,
  Box,
  Chip
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { getWhatsAppStatusColor, normalizeWhatsAppStatus } from '../../utils/whatsappStatus.js';

const QueueWhatsAppsModal = ({
  open,
  onClose,
  queue,
  service,
  onError
}) => {
  const [assigned, setAssigned] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);

  const disabled = loading || !queue;

  /* ===================== LOAD ===================== */
  const loadConnections = useCallback(async () => {
    if (!queue) return;

    setLoading(true);
    try {
      const [assignedRes, sessionsRes] = await Promise.all([
        service.getQueueWhatsApps(queue.id),
        service.listWhatsappSessions()
      ]);

      setAssigned(assignedRes || []);
      setSessions(sessionsRes || []);
    } catch (err) {
      onError?.(err);
    } finally {
      setLoading(false);
    }
  }, [queue, service, onError]);

  useEffect(() => {
    if (open) loadConnections();
  }, [open, loadConnections]);

  /* ===================== DERIVED ===================== */
  const assignedNames = useMemo(
    () => new Set(assigned.map(a => a.whatsapp_session_name)),
    [assigned]
  );

  const selectableSessions = useMemo(
    () => sessions.filter(s => !assignedNames.has(s.session)),
    [sessions, assignedNames]
  );

  /* ===================== ACTIONS ===================== */
  const handleAdd = async () => {
    if (!sessionName || disabled) return;

    setLoading(true);
    try {
      await service.addWhatsAppToQueue(queue.id, sessionName);
      setSessionName('');
      await loadConnections();
    } catch (err) {
      onError?.(err);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (name) => {
    if (disabled) return;

    setLoading(true);
    try {
      await service.removeWhatsAppFromQueue(queue.id, name);
      await loadConnections();
    } catch (err) {
      onError?.(err);
    } finally {
      setLoading(false);
    }
  };

  /* ===================== RENDER ===================== */
  return (
    <Dialog
      open={open}
      onClose={disabled ? undefined : onClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Conexiones WhatsApp en <strong>{queue?.name}</strong>
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {/* ===================== ADD ===================== */}
          <Stack spacing={1}>
            <Typography variant="subtitle2">
              Agregar conexión WhatsApp
            </Typography>

            <Select
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              fullWidth
              size="small"
              displayEmpty
              disabled={disabled}
            >
              <MenuItem value="">
                <em>Selecciona una sesión</em>
              </MenuItem>

              {selectableSessions.map(s => (
                <MenuItem key={s.session} value={s.session}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2">
                      {s.session}
                    </Typography>
                    <Chip
                      size="small"
                      label={normalizeWhatsAppStatus(s.status)}
                      color={getWhatsAppStatusColor(s.status)}
                    />
                  </Stack>
                </MenuItem>
              ))}
            </Select>

            <Button
              variant="contained"
              onClick={handleAdd}
              disabled={disabled || !sessionName}
            >
              Agregar
            </Button>
          </Stack>

          {/* ===================== ASSIGNED ===================== */}
          <Typography variant="subtitle2">
            Conexiones asignadas
          </Typography>

          {loading && (
            <Box display="flex" justifyContent="center">
              <CircularProgress size={24} />
            </Box>
          )}

          {!loading && assigned.length === 0 && (
            <Alert severity="info">
              No hay conexiones WhatsApp asignadas a esta cola.
            </Alert>
          )}

          <Stack spacing={1}>
            {assigned.map(it => (
              <Stack
                key={`${it.queue_id}-${it.whatsapp_session_name}`}
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                sx={(theme) => ({
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: 1,
                  p: 1,
                  bgcolor: theme.palette.background.paper
                })}
              >
                <Typography variant="body2">
                  {it.whatsapp_session_name}
                </Typography>

                <Tooltip title="Quitar de la cola" arrow>
                  <span>
                    <IconButton
                      size="small"
                      edge="end"
                      color="error"
                      onClick={() =>
                        handleRemove(it.whatsapp_session_name)
                      }
                      disabled={disabled}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          Cerrar
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default QueueWhatsAppsModal;
