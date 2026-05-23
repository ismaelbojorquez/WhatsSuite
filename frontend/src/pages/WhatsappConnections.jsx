import { useEffect, useState } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import PageLayout from '../components/PageLayout.jsx';
import WhatsAppSessionsList from '../components/whatsapp/WhatsAppSessionsList.jsx';
import WhatsAppQRCodeModal from '../components/whatsapp/WhatsAppQRCodeModal.jsx';
import WhatsAppPairingCodeModal from '../components/whatsapp/WhatsAppPairingCodeModal.jsx';
import ConnectionCountdownDialog from '../components/whatsapp/ConnectionCountdownDialog.jsx';
import { useWhatsappSessions } from '../context/WhatsappSessionsContext.jsx';
import { useConnectionCountdownsContext } from '../context/ConnectionCountdownContext.jsx';
import { getCountdownRemainingMs } from '../utils/countdown.js';

const WhatsappConnectionsContent = () => {
  const {
    sessions,
    sessionsMeta,
    activeQrSessionId,
    activePairingSessionId,
    globalError,
    actions: {
      syncSession,
      showQr,
      requestPairing,
      reconnect,
      disconnect,
      deleteSession,
      setPhone,
      clearQr,
      clearPairing,
      loadExistingSessions,
      updateSyncHistory,
      renewQr,
      resetAuth
    }
  } = useWhatsappSessions();
  const [newSessionId, setNewSessionId] = useState('');
  const [countdownSessionId, setCountdownSessionId] = useState(null);
  const {
    countdowns,
    now: countdownNow,
    startCountdown,
    cancelCountdown
  } = useConnectionCountdownsContext();

  useEffect(() => {
    loadExistingSessions();
  }, [loadExistingSessions]);

  const activeQrSession = sessions.find((s) => s.id === activeQrSessionId);
  const activePairingSession = sessions.find((s) => s.id === activePairingSessionId);
  const selectedCountdown = countdownSessionId ? countdowns[countdownSessionId] : null;
  const selectedCountdownRemainingMs = getCountdownRemainingMs(selectedCountdown, countdownNow);

  return (
    <PageLayout
      title="Conexiones WhatsApp"
      actions={
        <Alert severity={sessionsMeta.attention > 0 ? 'warning' : 'success'} sx={{ py: 0.5, px: 1.5 }}>
          {sessionsMeta.attention > 0
            ? `${sessionsMeta.attention} conexiones requieren atención`
            : 'Todas las conexiones estables'}
        </Alert>
      }
    >
      {globalError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {globalError}
        </Alert>
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ mb: 2 }}>
        <TextField
          label="ID de sesión"
          value={newSessionId}
          onChange={(e) => setNewSessionId(e.target.value)}
          placeholder="ej: tienda-1"
          size="small"
        />
        <Button
          variant="contained"
          onClick={() => {
            const id = (newSessionId || '').trim() || 'default';
            syncSession(id, { allowCreate: true });
          }}
        >
          Crear/recuperar sesión
        </Button>
        <Typography variant="body2" color="text.secondary">
          Soporta múltiples sesiones independientes. Usa un ID único por número/instancia.
        </Typography>
      </Stack>
      <WhatsAppSessionsList
        sessions={sessions}
        onShowQr={showQr}
        onRequestPairing={requestPairing}
        onReconnect={reconnect}
        onRenewQr={renewQr}
        onResetAuth={resetAuth}
        onDisconnect={disconnect}
        onDelete={deleteSession}
        onRefresh={syncSession}
        onPhoneChange={setPhone}
        onToggleSyncHistory={updateSyncHistory}
        countdowns={countdowns}
        countdownNow={countdownNow}
        onManageCountdown={setCountdownSessionId}
      />

      <WhatsAppQRCodeModal
        open={Boolean(activeQrSession)}
        sessionId={activeQrSession?.id}
        status={activeQrSession?.status}
        qr={activeQrSession?.qr}
        qrBase64={activeQrSession?.qrBase64}
        loading={activeQrSession?.loading}
        error={activeQrSession?.error ? new Error(activeQrSession.error) : null}
        onClose={clearQr}
      />

      <WhatsAppPairingCodeModal
        open={Boolean(activePairingSession)}
        sessionId={activePairingSession?.id}
        pairingCode={activePairingSession?.pairingCode}
        onClose={clearPairing}
      />

      <ConnectionCountdownDialog
        open={Boolean(countdownSessionId)}
        sessionId={countdownSessionId}
        countdown={selectedCountdown}
        remainingMs={selectedCountdownRemainingMs}
        onClose={() => setCountdownSessionId(null)}
        onStart={startCountdown}
        onCancel={cancelCountdown}
      />
    </PageLayout>
  );
};

const WhatsappConnections = () => <WhatsappConnectionsContent />;

export default WhatsappConnections;
