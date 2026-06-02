const CONNECTED_STATUSES = new Set(['connected', 'open', 'ready', 'online', 'active', 'authenticated']);
const PENDING_STATUSES = new Set([
  'pending',
  'connecting',
  'reconnecting',
  'restarting',
  'pairing_code',
  'qr',
  'scan_qr',
  'loading'
]);
const DISCONNECTED_STATUSES = new Set([
  'disconnected',
  'disconnect',
  'closed',
  'close',
  'invalid',
  'logged_out',
  'logout',
  'deleted',
  'error'
]);

export const normalizeWhatsAppStatus = (status, fallback = 'unknown') => {
  const raw = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!raw) return fallback;
  if (CONNECTED_STATUSES.has(raw)) return 'connected';
  if (PENDING_STATUSES.has(raw)) {
    if (raw === 'pairing_code') return 'pairing_code';
    if (raw === 'restarting') return 'restarting';
    if (raw === 'pending' || raw === 'qr' || raw === 'scan_qr') return 'pending';
    return 'connecting';
  }
  if (DISCONNECTED_STATUSES.has(raw)) return raw === 'invalid' ? 'invalid' : raw === 'error' ? 'error' : 'disconnected';
  return raw;
};

export const isWhatsAppConnected = (status) => normalizeWhatsAppStatus(status) === 'connected';

export const getWhatsAppStatusColor = (status, { unknown = 'default' } = {}) => {
  const normalized = normalizeWhatsAppStatus(status);
  if (normalized === 'connected') return 'success';
  if (normalized === 'connecting' || normalized === 'restarting' || normalized === 'pairing_code') return 'warning';
  if (normalized === 'pending') return 'info';
  if (normalized === 'invalid' || normalized === 'error') return 'error';
  if (normalized === 'disconnected') return 'default';
  return unknown;
};

export const getWhatsAppStatusLabel = (status) => {
  const normalized = normalizeWhatsAppStatus(status);
  if (normalized === 'connected') return 'Conectado';
  if (normalized === 'pending') return 'Pendiente';
  if (normalized === 'connecting') return 'Conectando';
  if (normalized === 'restarting') return 'Reiniciando';
  if (normalized === 'pairing_code') return 'Pairing code';
  if (normalized === 'disconnected') return 'Desconectado';
  if (normalized === 'invalid') return 'Invalido';
  if (normalized === 'error') return 'Error';
  return 'Desconocido';
};
