import { Fragment, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { Box, Stack, Skeleton, CircularProgress, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

const SCROLL_THRESHOLD = 120;
const DATE_FORMATTER = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

const getMessageDate = (message) => {
  const raw = message?.timestamp || message?.createdAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getDayKey = (date) => {
  if (!date) return 'sin-fecha';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDayLabel = (date) => {
  if (!date) return 'Sin fecha';

  const messageDay = new Date(date);
  messageDay.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffInDays = Math.round((today.getTime() - messageDay.getTime()) / 86400000);
  if (diffInDays === 0) return 'Hoy';
  if (diffInDays === 1) return 'Ayer';
  return DATE_FORMATTER.format(date);
};

const getMessageKey = (message, index) => {
  const id = message?.id || message?.whatsappMessageId;
  if (id) return `msg-${id}-${index}`;
  const stamp = message?.timestamp || message?.createdAt || 'no-ts';
  const direction = message?.direction || 'no-dir';
  return `msg-${direction}-${stamp}-${index}`;
};

const ChatPanel = ({
  messages = [],
  renderMessage,
  footer,
  loading = false,
  loadingMore = false,
  hasMore = false,
  onLoadMore = null,
  autoScrollKey = null
}) => {
  const scrollRef = useRef(null);
  const prevHeightRef = useRef(0);
  const isAtBottomRef = useRef(true);

  /* =========================
     SORT (estable)
  ========================== */
  const sortedMessages = useMemo(() => {
    if (!messages?.length) return [];
    const sortValue = (m) =>
      Number(new Date(m?.timestamp || m?.createdAt || 0).getTime()) || 0;
    const createdValue = (m) =>
      Number(new Date(m?.createdAt || m?.timestamp || 0).getTime()) || 0;
    const idValue = (m) => m?.whatsappMessageId || m?.id || '';
    return [...messages].sort((a, b) => {
      const ta = sortValue(a);
      const tb = sortValue(b);
      if (ta !== tb) return ta - tb;
      const ca = createdValue(a);
      const cb = createdValue(b);
      if (ca !== cb) return ca - cb;
      return idValue(a) < idValue(b) ? -1 : idValue(a) > idValue(b) ? 1 : 0;
    });
  }, [messages]);

  const timelineItems = useMemo(() => {
    if (!sortedMessages.length) return [];

    const items = [];
    let currentDayKey = null;

    sortedMessages.forEach((message, index) => {
      const date = getMessageDate(message);
      const dayKey = getDayKey(date);

      if (dayKey !== currentDayKey) {
        items.push({
          type: 'separator',
          key: `day-${dayKey}-${index}`,
          label: formatDayLabel(date)
        });
        currentDayKey = dayKey;
      }

      items.push({
        type: 'message',
        key: getMessageKey(message, index),
        message
      });
    });

    return items;
  }, [sortedMessages]);

  /* =========================
     SCROLL POSITION TRACKING
  ========================== */
  const handleScroll = useCallback(
    (evt) => {
      const el = evt.currentTarget;

      // Track bottom
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      isAtBottomRef.current = distanceFromBottom < SCROLL_THRESHOLD;

      // Load more (top)
      if (
        el.scrollTop <= 80 &&
        hasMore &&
        !loadingMore &&
        onLoadMore
      ) {
        prevHeightRef.current = el.scrollHeight;
        onLoadMore();
      }
    },
    [hasMore, loadingMore, onLoadMore]
  );

  /* =========================
     PRESERVE SCROLL ON LOAD MORE
  ========================== */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !loadingMore) return;

    const delta = el.scrollHeight - prevHeightRef.current;
    el.scrollTop = delta;
  }, [loadingMore]);

  /* =========================
     AUTO SCROLL (ONLY IF AT BOTTOM)
  ========================== */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoScrollKey === false) return;

    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [autoScrollKey, sortedMessages.length]);

  /* =========================
     RENDER
  ========================== */
  return (
    <Stack sx={{ flex: 1, minHeight: 0, bgcolor: 'background.paper' }}>
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: 2,
          py: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 1
        }}
      >
        {/* Load older */}
        {hasMore && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            {loadingMore ? (
              <CircularProgress size={18} />
            ) : (
              <Skeleton variant="text" width={120} />
            )}
          </Box>
        )}

        {/* Initial loading */}
        {loading &&
          Array.from({ length: 6 }).map((_, idx) => (
            <Stack
              key={idx}
              spacing={0.75}
              sx={{ maxWidth: '70%' }}
            >
              <Skeleton
                variant="rectangular"
                height={36}
                sx={{ borderRadius: 2 }}
              />
              <Skeleton variant="text" width="35%" />
            </Stack>
          ))}

        {/* Messages */}
        {!loading &&
          timelineItems.map((item) => {
            if (item.type === 'separator') {
              return (
                <Box key={item.key} sx={{ display: 'flex', justifyContent: 'center', py: 0.25 }}>
                  <Box
                    sx={(theme) => ({
                      px: 1.25,
                      py: 0.35,
                      borderRadius: 10,
                      bgcolor: alpha(theme.palette.primary.main, 0.08),
                      border: `1px solid ${alpha(theme.palette.primary.main, 0.16)}`
                    })}
                  >
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'capitalize' }}>
                      {item.label}
                    </Typography>
                  </Box>
                </Box>
              );
            }

            return (
              <Fragment key={item.key}>
                {renderMessage ? renderMessage(item.message) : null}
              </Fragment>
            );
          })}
      </Box>

      {/* Footer */}
      {footer}
    </Stack>
  );
};

export default ChatPanel;
