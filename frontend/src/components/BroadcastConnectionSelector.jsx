import { Autocomplete, Chip, Stack, TextField, Typography, Box } from '@mui/material';
import { getWhatsAppStatusColor, normalizeWhatsAppStatus } from '../utils/whatsappStatus.js';

const BroadcastConnectionSelector = ({ connections = [], value = [], onChange, disabled = false }) => {
  const mapped = connections.map((c) => ({
    label: c.session || c.session_name || c.id || 'default',
    status: normalizeWhatsAppStatus(c.status)
  }));
  const selected = mapped.filter((opt) => value.includes(opt.label));

  return (
    <Stack spacing={1.2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2" fontWeight={700}>
          Conexiones WhatsApp
        </Typography>
      </Stack>
      <Autocomplete
        multiple
        disableCloseOnSelect
        options={mapped}
        value={selected}
        getOptionLabel={(option) => option.label}
        onChange={(_e, items) => onChange(items.map((i) => i.label))}
        disabled={disabled}
        renderInput={(params) => <TextField {...params} label="Selecciona conexiones" placeholder="session-01" />}
        renderOption={(props, option) => (
          <Box component="li" {...props} key={option.label} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip size="small" color={getWhatsAppStatusColor(option.status, { unknown: 'error' })} label={option.status || 'desconocido'} />
            <Typography variant="body2">{option.label}</Typography>
          </Box>
        )}
        renderTags={(tagValue, getTagProps) =>
          tagValue.map((option, index) => (
            <Chip
              {...getTagProps({ index })}
              key={option.label}
              label={option.label}
              color={getWhatsAppStatusColor(option.status, { unknown: 'error' })}
              size="small"
            />
          ))
        }
      />
    </Stack>
  );
};

export default BroadcastConnectionSelector;
