export const LOCAL_NOTIFICATION_EVENT = 'whatssuite:local-notification';

export const dispatchLocalNotification = (detail) => {
  if (typeof window === 'undefined') return;

  try {
    window.dispatchEvent(new CustomEvent(LOCAL_NOTIFICATION_EVENT, { detail }));
  } catch {
    // Local UI notifications are best-effort.
  }
};
