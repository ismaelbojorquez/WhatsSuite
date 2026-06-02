import { memo } from 'react';
import { alpha, Card, CardContent, Stack, Typography, Box } from '@mui/material';

/**
 * Premium wrapper para gráficas con iconografía y gradiente.
 * @param {{ icon?: React.ReactNode, title: string, subtitle?: string, children: React.ReactNode, hint?: string }} props
 */
const ChartCard = memo(({ icon, title, subtitle, children, hint = null }) => {
  return (
    <Card
      elevation={0}
      sx={(theme) => ({
        position: 'relative',
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.08)}, ${alpha(
          theme.palette.primary.light,
          theme.palette.mode === 'dark' ? 0.18 : 0.12
        )})`,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.12)}`,
        transition: 'transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: theme.shadows[6],
          borderColor: alpha(theme.palette.primary.main, 0.25)
        }
      })}
    >
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1 }}>
          {icon && (
            <Box
              sx={(theme) => ({
                width: 40,
                height: 40,
                borderRadius: 1.5,
                display: 'grid',
                placeItems: 'center',
                background: `linear-gradient(145deg, ${alpha(theme.palette.primary.dark, 0.2)}, ${alpha(
                  theme.palette.primary.main,
                  0.14
                )})`,
                color: theme.palette.primary.contrastText
              })}
            >
              {icon}
            </Box>
          )}
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>
              {title}
            </Typography>
            {subtitle && (
              <Typography variant="caption" color="text.secondary">
                {subtitle}
              </Typography>
            )}
          </Box>
          <Box sx={{ flex: 1 }} />
          {hint ? (
            <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.8 }}>
              {hint}
            </Typography>
          ) : null}
        </Stack>
        <Box sx={{ position: 'relative' }}>{children}</Box>
      </CardContent>
    </Card>
  );
});

export default ChartCard;
