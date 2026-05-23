import { Box, Stack } from '@mui/material';
import WhatsAppSessionCard from './WhatsAppSessionCard.jsx';
import SkeletonList from '../ui/SkeletonList.jsx';
import EmptyState from '../ui/EmptyState.jsx';

const WhatsAppSessionsList = ({
  sessions = [],
  onShowQr,
  onRequestPairing,
  onReconnect,
  onRenewQr,
  onResetAuth,
  onDisconnect,
  onDelete,
  onRefresh,
  onPhoneChange,
  onToggleSyncHistory = () => {},
  countdowns = {},
  countdownNow,
  onManageCountdown,
  loading = false
}) => {
  /* ===================== GLOBAL LOADING ===================== */
  if (loading && sessions.length === 0) {
    return <SkeletonList rows={3} variant="card" withAvatar={false} />;
  }

  /* ===================== EMPTY ===================== */
  if (!loading && sessions.length === 0) {
    return (
      <EmptyState
        title="Sin sesiones"
        description="Crea la primera sesión para comenzar."
      />
    );
  }

  /* ===================== LIST ===================== */
  return (
    <Stack spacing={2} aria-busy={loading}>
      {sessions.map((session) => {
        const sessionId = session.session || session.id;
        return (
          <Box key={sessionId || session.id}>
            {session.loading && !session.status ? (
              <SkeletonList rows={2} variant="card" withAvatar={false} />
            ) : (
              <WhatsAppSessionCard
                session={{ ...session, session: sessionId }}
                onShowQr={onShowQr}
                onRequestPairing={onRequestPairing}
                onReconnect={onReconnect}
                onRenewQr={onRenewQr}
                onResetAuth={onResetAuth}
                onDisconnect={onDisconnect}
                onDelete={onDelete}
                onRefresh={onRefresh}
                onPhoneChange={onPhoneChange}
                onToggleSyncHistory={onToggleSyncHistory}
                countdown={countdowns[sessionId]}
                countdownNow={countdownNow}
                onManageCountdown={onManageCountdown}
              />
            )}
          </Box>
        );
      })}
    </Stack>
  );
};

export default WhatsAppSessionsList;
