import { memo, useMemo } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  LinearProgress,
  Skeleton,
  Stack,
  Typography,
  Divider,
  Chip
} from '@mui/material';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';

const LEVELS = [
  { value: 'agent', label: 'Agente' },
  { value: 'connection', label: 'Conexion' },
  { value: 'hour', label: 'Hora' },
  { value: 'queue', label: 'Cola' },
  { value: 'status', label: 'Estado' },
  { value: 'message_type', label: 'Tipo' }
];

const formatNumber = (value) => Number(value || 0).toLocaleString('es-MX');

const ChartDrilldownModal = memo(({ open, datum, level = 'agent', loading = false, onClose, onFilterChange }) => {
  const label = datum?.label || 'Sin seleccion';
  const value = Number(datum?.value || 0);
  const rows = datum?.data || [];
  const maxValue = useMemo(() => Math.max(...rows.map((row) => Number(row.value || 0)), 1), [rows]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack spacing={0.5}>
          <Typography variant="h6" fontWeight={850}>
            Detalle de {label}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {datum?.source || 'Desglose operativo'}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip label={datum?.source || 'Total'} color="primary" variant="outlined" icon={<InsightsRoundedIcon />} />
            <Typography variant="h4" fontWeight={900} sx={{ lineHeight: 1 }}>
              {formatNumber(value)}
            </Typography>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {LEVELS.map((item) => (
              <Button
                key={item.value}
                size="small"
                variant={level === item.value ? 'contained' : 'outlined'}
                onClick={() => onFilterChange?.(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </Stack>

          <Divider />

          {loading ? (
            <Stack spacing={1}>
              {[0, 1, 2, 3, 4].map((item) => (
                <Skeleton key={item} height={34} />
              ))}
            </Stack>
          ) : rows.length ? (
            <Stack spacing={1.25}>
              {rows.slice(0, 12).map((row, index) => {
                const rowValue = Number(row.value || 0);
                return (
                  <Box key={`${row.label}-${index}`}>
                    <Stack direction="row" justifyContent="space-between" spacing={1}>
                      <Typography variant="body2" noWrap>
                        {row.label}
                      </Typography>
                      <Typography variant="body2" fontWeight={800} noWrap>
                        {formatNumber(rowValue)}
                      </Typography>
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={(rowValue / maxValue) * 100}
                      sx={{
                        height: 7,
                        borderRadius: 999,
                        mt: 0.65,
                        '& .MuiLinearProgress-bar': { borderRadius: 999 }
                      }}
                    />
                  </Box>
                );
              })}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Sin datos
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cerrar</Button>
      </DialogActions>
    </Dialog>
  );
});

export default ChartDrilldownModal;
