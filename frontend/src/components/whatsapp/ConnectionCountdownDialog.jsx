import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { formatCountdownDuration } from '../../utils/countdown.js';

const QUICK_OPTIONS = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: '2 h', minutes: 120 }
];

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const ConnectionCountdownDialog = ({
  open,
  sessionId,
  countdown,
  remainingMs = 0,
  onClose,
  onStart,
  onCancel
}) => {
  const [hours, setHours] = useState('0');
  const [minutes, setMinutes] = useState('15');

  const active = Boolean(countdown && remainingMs > 0);
  const durationMinutes = useMemo(() => parsePositiveInt(hours) * 60 + parsePositiveInt(minutes), [hours, minutes]);
  const endsAtLabel = countdown?.endsAt ? new Date(countdown.endsAt).toLocaleString() : null;

  useEffect(() => {
    if (!open) return;

    const msUntilEnd = countdown?.endsAt ? Math.max(0, countdown.endsAt - Date.now()) : 0;
    const totalMinutes = msUntilEnd > 0 ? Math.max(1, Math.ceil(msUntilEnd / 60000)) : 15;
    setHours(String(Math.floor(totalMinutes / 60)));
    setMinutes(String(totalMinutes % 60));
  }, [countdown?.endsAt, open, sessionId]);

  const handleQuickOption = (optionMinutes) => {
    setHours(String(Math.floor(optionMinutes / 60)));
    setMinutes(String(optionMinutes % 60));
  };

  const handleStart = () => {
    if (!sessionId || durationMinutes <= 0) return;
    onStart?.(sessionId, durationMinutes * 60000);
    onClose?.();
  };

  const handleCancel = () => {
    if (!sessionId) return;
    onCancel?.(sessionId);
    onClose?.();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Countdown de desbloqueo</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <AccessTimeIcon color="action" fontSize="small" />
            <Typography variant="body2" color="text.secondary">
              Conexión: <strong>{sessionId || 'N/D'}</strong>
            </Typography>
          </Stack>

          {active && (
            <Alert severity="warning">
              Faltan {formatCountdownDuration(remainingMs)}
              {endsAtLabel ? ` - termina ${endsAtLabel}` : ''}.
            </Alert>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="Horas"
              type="number"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              inputProps={{ min: 0, max: 168, step: 1 }}
              fullWidth
            />
            <TextField
              label="Minutos"
              type="number"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              inputProps={{ min: 0, max: 59, step: 1 }}
              fullWidth
            />
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {QUICK_OPTIONS.map((option) => (
              <Button
                key={option.minutes}
                variant="outlined"
                size="small"
                color="inherit"
                onClick={() => handleQuickOption(option.minutes)}
              >
                {option.label}
              </Button>
            ))}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button variant="text" color="inherit" onClick={onClose}>
          Cerrar
        </Button>
        {active && (
          <Button variant="outlined" color="error" onClick={handleCancel}>
            Detener
          </Button>
        )}
        <Button variant="contained" onClick={handleStart} disabled={durationMinutes <= 0}>
          {active ? 'Actualizar countdown' : 'Iniciar countdown'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ConnectionCountdownDialog;
