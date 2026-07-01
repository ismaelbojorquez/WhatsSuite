// Inicialización de sesiones WhatsApp persistentes
import pool from '../infra/db/postgres.js';
import logger from '../infra/logging/logger.js';
import { createSession } from '../services/whatsappService.js';
import whatsappManager from './whatsappManager.js';

export const initWhatsAppModule = async (connectionId) => whatsappManager.start(connectionId);
export const resetWhatsAppModule = async () => whatsappManager.stop();
export const getWhatsAppStatus = () => whatsappManager.getStatus();

// Recorre whatsapp_sessions y levanta sockets al arrancar el backend.
export const bootstrapValidSessions = async () => {
  const { rows } = await pool.query('SELECT session_name FROM whatsapp_sessions WHERE deleted_at IS NULL');
  const sessions = rows.map((r) => r.session_name);
  let recovered = 0;
  for (const name of sessions) {
    try {
      await createSession(name, { userId: null, ip: 'bootstrap' });
      recovered += 1;
    } catch (err) {
      logger.error({ err, sessionName: name }, 'Failed to bootstrap WhatsApp session');
    }
  }
  return { recovered };
};

export default whatsappManager;
