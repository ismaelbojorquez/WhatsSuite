import { useEffect, useMemo, useState, useCallback, memo } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  IconButton,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import dayjs from 'dayjs';
import { useAuth } from '../context/AuthContext.jsx';
import createDashboardApi from '../services/dashboard.api.js';
import DateRangeFilter from '../components/DateRangeFilter.jsx';
import { ChartCard, PremiumBarChart, PremiumLineChart, ChartDrilldownModal } from '../components/charts/index.js';
import ShowChartRoundedIcon from '@mui/icons-material/ShowChartRounded';
import TimelineRoundedIcon from '@mui/icons-material/TimelineRounded';
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import MarkChatUnreadRoundedIcon from '@mui/icons-material/MarkChatUnreadRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import MoveToInboxRoundedIcon from '@mui/icons-material/MoveToInboxRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import GraphicEqRoundedIcon from '@mui/icons-material/GraphicEqRounded';
import PercentRoundedIcon from '@mui/icons-material/PercentRounded';
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import WifiTetheringRoundedIcon from '@mui/icons-material/WifiTetheringRounded';
import DonutLargeRoundedIcon from '@mui/icons-material/DonutLargeRounded';

const number = (value, decimals = 0) =>
  Number(value || 0).toLocaleString('es-MX', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });

const percent = (value) => `${number(value, Number(value) % 1 ? 1 : 0)}%`;

const seconds = (value) => {
  const total = Number(value || 0);
  if (!total) return '0s';
  if (total < 60) return `${number(total, 0)}s`;
  const minutes = total / 60;
  if (minutes < 60) return `${number(minutes, 1)}m`;
  return `${number(minutes / 60, 1)}h`;
};

const chartRows = (rows, labelKey, valueKey, limit = 10) =>
  (rows || [])
    .slice(0, limit)
    .map((row) => ({
      label: String(row[labelKey] || 'Sin dato'),
      value: Number(row[valueKey] || 0)
    }));

const KpiCard = memo(({ title, value, helper, icon, color = '#2563eb', loading }) => (
  <Card
    elevation={0}
    sx={(theme) => ({
      height: '100%',
      border: `1px solid ${theme.palette.divider}`,
      borderLeft: `4px solid ${color}`,
      background: theme.palette.mode === 'dark' ? 'rgba(15,23,42,0.72)' : '#fff',
      transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease',
      '&:hover': {
        transform: 'translateY(-2px)',
        boxShadow: theme.shadows[5],
        borderColor: color
      }
    })}
  >
    <CardContent sx={{ p: 2 }}>
      <Stack direction="row" spacing={1.25} alignItems="flex-start">
        <Avatar
          sx={{
            width: 36,
            height: 36,
            bgcolor: `${color}1f`,
            color,
            borderRadius: 1.5
          }}
        >
          {icon}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="caption" color="text.secondary" noWrap>
            {title}
          </Typography>
          {loading ? (
            <Skeleton variant="text" width="70%" height={34} sx={{ mt: 0.5 }} />
          ) : (
            <Typography variant="h5" fontWeight={850} sx={{ mt: 0.25, lineHeight: 1.15 }} noWrap>
              {value}
            </Typography>
          )}
          {helper ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }} noWrap>
              {helper}
            </Typography>
          ) : null}
        </Box>
      </Stack>
    </CardContent>
  </Card>
));

const SummaryStrip = memo(({ overview, busiestDay, topQueue, peakHour, loading }) => (
  <Paper
    elevation={0}
    sx={(theme) => ({
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: 2,
      p: 2,
      bgcolor: theme.palette.mode === 'dark' ? 'rgba(2,6,23,0.54)' : 'rgba(248,250,252,0.86)'
    })}
  >
    {loading ? (
      <Skeleton height={36} />
    ) : (
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip icon={<TimelineRoundedIcon />} label={`${overview?.periodo_dias || 0} dias analizados`} />
        <Chip icon={<SpeedRoundedIcon />} label={`${number(overview?.promedio_mensajes_dia, 1)} mensajes/dia`} />
        <Chip icon={<PercentRoundedIcon />} label={`${percent(overview?.tasa_cierre)} cierre`} />
        <Chip icon={<ShowChartRoundedIcon />} label={`${busiestDay?.label || 'Sin pico'}: ${number(busiestDay?.value)}`} />
        <Chip icon={<HubRoundedIcon />} label={`${topQueue?.label || 'Sin cola'}: ${number(topQueue?.value)} mensajes`} />
        <Chip icon={<ScheduleRoundedIcon />} label={`${peakHour?.label || 'Sin hora'}: ${number(peakHour?.value)}`} />
      </Stack>
    )}
  </Paper>
));

const RankedList = memo(({ title, icon, rows = [], valueLabel = 'mensajes', color = '#2563eb', loading }) => {
  const max = Math.max(...rows.map((row) => Number(row.value || 0)), 1);
  return (
    <Card elevation={0} sx={(theme) => ({ height: '100%', border: `1px solid ${theme.palette.divider}` })}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <Avatar sx={{ width: 34, height: 34, bgcolor: `${color}1f`, color, borderRadius: 1.5 }}>{icon}</Avatar>
          <Typography variant="subtitle1" fontWeight={800}>
            {title}
          </Typography>
        </Stack>
        {loading ? (
          <Stack spacing={1}>
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} height={30} />
            ))}
          </Stack>
        ) : rows.length ? (
          <Stack spacing={1.2}>
            {rows.slice(0, 6).map((row, index) => (
              <Box key={`${row.label}-${index}`}>
                <Stack direction="row" justifyContent="space-between" spacing={1}>
                  <Typography variant="body2" noWrap>
                    {row.label}
                  </Typography>
                  <Typography variant="body2" fontWeight={800} noWrap>
                    {number(row.value)} {valueLabel}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={(Number(row.value || 0) / max) * 100}
                  sx={{
                    height: 7,
                    borderRadius: 999,
                    mt: 0.6,
                    bgcolor: `${color}18`,
                    '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 999 }
                  }}
                />
              </Box>
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Sin datos
          </Typography>
        )}
      </CardContent>
    </Card>
  );
});

const QueuePerformance = memo(({ rows = [], loading }) => {
  const maxMessages = Math.max(...rows.map((row) => Number(row.total_mensajes || 0)), 1);
  return (
    <Card elevation={0} sx={(theme) => ({ border: `1px solid ${theme.palette.divider}` })}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <Avatar sx={{ width: 34, height: 34, bgcolor: '#14b8a61f', color: '#0f766e', borderRadius: 1.5 }}>
            <GroupsRoundedIcon fontSize="small" />
          </Avatar>
          <Typography variant="subtitle1" fontWeight={800}>
            Rendimiento por cola
          </Typography>
        </Stack>
        {loading ? (
          <Stack spacing={1}>
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} height={42} />
            ))}
          </Stack>
        ) : rows.length ? (
          <Stack spacing={1.5}>
            {rows.slice(0, 8).map((row) => {
              const messages = Number(row.total_mensajes || 0);
              return (
                <Box key={row.queue_id || row.queue_name}>
                  <Grid container spacing={1.5} alignItems="center">
                    <Grid item xs={12} md={4}>
                      <Typography variant="body2" fontWeight={750} noWrap>
                        {row.queue_name || 'Sin cola'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {number(row.total_chats)} chats
                      </Typography>
                    </Grid>
                    <Grid item xs={6} md={2}>
                      <Typography variant="caption" color="text.secondary">
                        Mensajes
                      </Typography>
                      <Typography variant="body2" fontWeight={800}>
                        {number(messages)}
                      </Typography>
                    </Grid>
                    <Grid item xs={6} md={2}>
                      <Typography variant="caption" color="text.secondary">
                        Cierre
                      </Typography>
                      <Typography variant="body2" fontWeight={800}>
                        {percent(row.tasa_cierre)}
                      </Typography>
                    </Grid>
                    <Grid item xs={6} md={2}>
                      <Typography variant="caption" color="text.secondary">
                        Resp.
                      </Typography>
                      <Typography variant="body2" fontWeight={800}>
                        {seconds(row.tiempo_respuesta_promedio)}
                      </Typography>
                    </Grid>
                    <Grid item xs={6} md={2}>
                      <Typography variant="caption" color="text.secondary">
                        Msg/chat
                      </Typography>
                      <Typography variant="body2" fontWeight={800}>
                        {number(row.mensajes_por_chat, 1)}
                      </Typography>
                    </Grid>
                  </Grid>
                  <LinearProgress
                    variant="determinate"
                    value={(messages / maxMessages) * 100}
                    sx={{
                      height: 7,
                      borderRadius: 999,
                      mt: 1,
                      bgcolor: '#14b8a618',
                      '& .MuiLinearProgress-bar': { bgcolor: '#14b8a6', borderRadius: 999 }
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
      </CardContent>
    </Card>
  );
});

const Dashboard = () => {
  const { token, logout } = useAuth();

  const api = useMemo(
    () =>
      createDashboardApi({
        getToken: () => token,
        onUnauthorized: () => logout({ remote: false, reason: 'Sesion expirada o invalida' })
      }),
    [token, logout]
  );

  const [filters, setFilters] = useState(() => ({
    fecha_inicio: dayjs().subtract(7, 'day').format('YYYY-MM-DD'),
    fecha_fin: dayjs().format('YYYY-MM-DD')
  }));

  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState(null);
  const [timeseries, setTimeseries] = useState([]);
  const [queues, setQueues] = useState([]);
  const [drilldowns, setDrilldowns] = useState({
    agent: [],
    connection: [],
    hour: [],
    status: [],
    message_type: []
  });
  const [error, setError] = useState(null);
  const [drilldownOpen, setDrilldownOpen] = useState(false);
  const [drilldownDatum, setDrilldownDatum] = useState(null);
  const [drilldownLevel, setDrilldownLevel] = useState('agent');
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const mapSeries = useCallback(
    (key) =>
      timeseries.map((row) => ({
        label: dayjs(row.date_key).format('DD/MM'),
        value: Number(row[key] || 0)
      })),
    [timeseries]
  );

  const loadData = useCallback(async () => {
    if (!filters.fecha_inicio || !filters.fecha_fin) return;

    setLoading(true);
    setError(null);

    try {
      const [ov, ts, queueRows, agents, connections, hours, statuses, types] = await Promise.all([
        api.getDashboardOverview(filters),
        api.getDashboardMessages(filters),
        api.getDashboardChats(filters),
        api.getDashboardDrilldown({ ...filters, level: 'agent' }),
        api.getDashboardDrilldown({ ...filters, level: 'connection' }),
        api.getDashboardDrilldown({ ...filters, level: 'hour' }),
        api.getDashboardDrilldown({ ...filters, level: 'status' }),
        api.getDashboardDrilldown({ ...filters, level: 'message_type' })
      ]);

      setOverview(ov || {});
      setTimeseries(ts || []);
      setQueues(queueRows || []);
      setDrilldowns({
        agent: agents || [],
        connection: connections || [],
        hour: hours || [],
        status: statuses || [],
        message_type: types || []
      });
    } catch (e) {
      setError(e?.message || 'Error al cargar dashboard');
    } finally {
      setLoading(false);
    }
  }, [api, filters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const directionTotals = useMemo(
    () => [
      { label: 'Entrantes', value: Number(overview?.mensajes_entrantes || 0) },
      { label: 'Salientes', value: Number(overview?.mensajes_salientes || 0) }
    ],
    [overview]
  );

  const mediaTotals = useMemo(
    () => [
      { label: 'Archivos', value: Number(overview?.archivos_enviados || 0) },
      { label: 'Audios', value: Number(overview?.audios_enviados || 0) }
    ],
    [overview]
  );

  const hourlyData = useMemo(
    () =>
      (drilldowns.hour || []).map((row) => ({
        label: `${String(row.label).padStart(2, '0')}:00`,
        value: Number(row.value || 0)
      })),
    [drilldowns.hour]
  );

  const agentData = useMemo(() => chartRows(drilldowns.agent, 'label', 'value', 8), [drilldowns.agent]);
  const connectionData = useMemo(() => chartRows(drilldowns.connection, 'label', 'value', 8), [drilldowns.connection]);
  const statusData = useMemo(() => chartRows(drilldowns.status, 'label', 'value', 6), [drilldowns.status]);
  const typeData = useMemo(() => chartRows(drilldowns.message_type, 'label', 'value', 6), [drilldowns.message_type]);
  const queueMessages = useMemo(() => chartRows(queues, 'queue_name', 'total_mensajes', 10), [queues]);
  const queueResponse = useMemo(() => chartRows(queues, 'queue_name', 'tiempo_respuesta_promedio', 8), [queues]);
  const busiestDay = useMemo(
    () => mapSeries('total_mensajes').reduce((best, row) => (row.value > (best?.value || 0) ? row : best), null),
    [mapSeries]
  );
  const topQueue = queueMessages[0] || null;
  const peakHour = hourlyData.reduce((best, row) => (row.value > (best?.value || 0) ? row : best), null);

  const kpis = useMemo(
    () => [
      {
        title: 'Total mensajes',
        value: number(overview?.total_mensajes),
        helper: `${number(overview?.promedio_mensajes_dia, 1)} por dia`,
        icon: <MarkChatUnreadRoundedIcon fontSize="small" />,
        color: '#2563eb'
      },
      {
        title: 'Entrantes',
        value: number(overview?.mensajes_entrantes),
        helper: percent(overview?.porcentaje_entrantes),
        icon: <MoveToInboxRoundedIcon fontSize="small" />,
        color: '#0891b2'
      },
      {
        title: 'Salientes',
        value: number(overview?.mensajes_salientes),
        helper: percent(overview?.porcentaje_salientes),
        icon: <SendRoundedIcon fontSize="small" />,
        color: '#16a34a'
      },
      {
        title: 'Chats totales',
        value: number(overview?.total_chats),
        helper: `${number(overview?.mensajes_por_chat, 1)} msg/chat`,
        icon: <ForumRoundedIcon fontSize="small" />,
        color: '#7c3aed'
      },
      {
        title: 'Chats abiertos',
        value: number(overview?.total_chats_abiertos),
        helper: 'OPEN + UNASSIGNED',
        icon: <GroupsRoundedIcon fontSize="small" />,
        color: '#f59e0b'
      },
      {
        title: 'Chats cerrados',
        value: number(overview?.total_chats_cerrados),
        helper: percent(overview?.tasa_cierre),
        icon: <TaskAltRoundedIcon fontSize="small" />,
        color: '#059669'
      },
      {
        title: 'Resp. promedio',
        value: seconds(overview?.tiempo_respuesta_promedio),
        helper: 'por ciclo de chat',
        icon: <AccessTimeRoundedIcon fontSize="small" />,
        color: '#dc2626'
      },
      {
        title: 'Archivos enviados',
        value: number(overview?.archivos_enviados),
        helper: percent(overview?.porcentaje_media),
        icon: <AttachFileRoundedIcon fontSize="small" />,
        color: '#9333ea'
      },
      {
        title: 'Audios enviados',
        value: number(overview?.audios_enviados),
        helper: percent(overview?.porcentaje_audio),
        icon: <GraphicEqRoundedIcon fontSize="small" />,
        color: '#0d9488'
      },
      {
        title: 'Ratio salida/entrada',
        value: number(overview?.ratio_salientes_entrantes, 2),
        helper: 'balance operativo',
        icon: <PercentRoundedIcon fontSize="small" />,
        color: '#e11d48'
      },
      {
        title: 'Hora pico',
        value: peakHour?.label || '—',
        helper: `${number(peakHour?.value)} mensajes`,
        icon: <ScheduleRoundedIcon fontSize="small" />,
        color: '#ea580c'
      },
      {
        title: 'Cola lider',
        value: topQueue?.label || '—',
        helper: `${number(topQueue?.value)} mensajes`,
        icon: <HubRoundedIcon fontSize="small" />,
        color: '#0284c7'
      }
    ],
    [overview, peakHour, topQueue]
  );

  const handleDrilldown = useCallback(
    (datum, source, level = 'agent') => {
      setDrilldownLevel(level);
      setDrilldownDatum({
        ...datum,
        source,
        data: chartRows(drilldowns[level] || [], 'label', 'value', 20)
      });
      setDrilldownOpen(true);
    },
    [drilldowns]
  );

  const handleDrilldownFilter = useCallback(
    async (level) => {
      setDrilldownLevel(level);
      const cached = drilldowns[level];
      if (cached?.length) {
        setDrilldownDatum((prev) => (prev ? { ...prev, level, data: chartRows(cached, 'label', 'value', 20) } : null));
        return;
      }
      setDrilldownLoading(true);
      try {
        const rows = await api.getDashboardDrilldown({ ...filters, level });
        setDrilldowns((prev) => ({ ...prev, [level]: rows || [] }));
        setDrilldownDatum((prev) => (prev ? { ...prev, level, data: chartRows(rows, 'label', 'value', 20) } : null));
      } catch (e) {
        setError(e?.message || 'Error al cargar drilldown');
      } finally {
        setDrilldownLoading(false);
      }
    },
    [api, drilldowns, filters]
  );

  return (
    <Box sx={{ minHeight: '100vh', p: { xs: 2, md: 3 } }}>
      <Stack spacing={2.5}>
        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          justifyContent="space-between"
          alignItems={{ lg: 'center' }}
          spacing={2}
        >
          <Box>
            <Typography variant="h5" fontWeight={900} sx={{ lineHeight: 1.15 }}>
              Dashboard Operativo
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {dayjs(filters.fecha_inicio).format('DD/MM/YYYY')} - {dayjs(filters.fecha_fin).format('DD/MM/YYYY')}
            </Typography>
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
            <DateRangeFilter
              from={filters.fecha_inicio}
              to={filters.fecha_fin}
              loading={loading}
              onChange={(f) => setFilters((prev) => ({ ...prev, ...f }))}
              onSubmit={loadData}
            />
            <Tooltip title="Actualizar">
              <IconButton onClick={loadData} disabled={loading} color="primary" sx={{ border: 1, borderColor: 'divider' }}>
                <RefreshRoundedIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <SummaryStrip overview={overview} busiestDay={busiestDay} topQueue={topQueue} peakHour={peakHour} loading={loading} />

        <Grid container spacing={2}>
          {kpis.map((item) => (
            <Grid key={item.title} item xs={12} sm={6} md={4} lg={3}>
              <KpiCard {...item} loading={loading} />
            </Grid>
          ))}
        </Grid>

        <Divider />

        <Grid container spacing={2}>
          <Grid item xs={12} lg={8}>
            <ChartCard icon={<ShowChartRoundedIcon />} title="Tendencia de mensajes" subtitle="Volumen diario" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={282} />
              ) : (
                <PremiumLineChart
                  data={mapSeries('total_mensajes')}
                  height={282}
                  color="#0891b2"
                  onSelect={(d) => handleDrilldown(d, 'Tendencia diaria', 'day')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} lg={4}>
            <ChartCard icon={<DonutLargeRoundedIcon />} title="Entrada vs salida" subtitle="Distribucion acumulada" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={282} />
              ) : (
                <PremiumBarChart
                  data={directionTotals}
                  height={282}
                  colors={['#38bdf8', '#16a34a']}
                  onSelect={(d) => handleDrilldown(d, 'Entrada vs salida', 'agent')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ChartCard icon={<TimelineRoundedIcon />} title="Entrantes por dia" subtitle="Demanda recibida" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={238} />
              ) : (
                <PremiumBarChart
                  data={mapSeries('mensajes_entrantes')}
                  height={238}
                  colors={['#06b6d4', '#0e7490']}
                  onSelect={(d) => handleDrilldown(d, 'Entrantes', 'connection')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ChartCard icon={<QueryStatsRoundedIcon />} title="Salientes por dia" subtitle="Actividad de respuesta" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={238} />
              ) : (
                <PremiumBarChart
                  data={mapSeries('mensajes_salientes')}
                  height={238}
                  colors={['#22c55e', '#15803d']}
                  onSelect={(d) => handleDrilldown(d, 'Salientes', 'agent')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ChartCard icon={<ScheduleRoundedIcon />} title="Actividad por hora" subtitle="Concentracion operativa" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={238} />
              ) : (
                <PremiumBarChart
                  data={hourlyData}
                  height={238}
                  colors={['#f59e0b', '#ea580c']}
                  onSelect={(d) => handleDrilldown(d, 'Actividad por hora', 'hour')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ChartCard icon={<HubRoundedIcon />} title="Mensajes por cola" subtitle="Carga por equipo" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={238} />
              ) : (
                <PremiumBarChart
                  data={queueMessages}
                  height={238}
                  colors={['#14b8a6', '#0f766e']}
                  onSelect={(d) => handleDrilldown(d, 'Mensajes por cola', 'queue')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ChartCard icon={<AccessTimeRoundedIcon />} title="Respuesta por cola" subtitle="Segundos promedio" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={238} />
              ) : (
                <PremiumBarChart
                  data={queueResponse}
                  height={238}
                  colors={['#fb7185', '#be123c']}
                  onSelect={(d) => handleDrilldown(d, 'Respuesta por cola', 'queue')}
                />
              )}
            </ChartCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ChartCard icon={<AttachFileRoundedIcon />} title="Media enviada" subtitle="Archivos y audios" hint={null}>
              {loading ? (
                <Skeleton variant="rectangular" height={238} />
              ) : (
                <PremiumBarChart
                  data={mediaTotals}
                  height={238}
                  colors={['#a855f7', '#7e22ce']}
                  onSelect={(d) => handleDrilldown(d, 'Media enviada', 'message_type')}
                />
              )}
            </ChartCard>
          </Grid>
        </Grid>

        <Grid container spacing={2}>
          <Grid item xs={12} lg={4}>
            <RankedList
              title="Agentes con mas movimiento"
              icon={<PersonOutlineRoundedIcon fontSize="small" />}
              rows={agentData}
              color="#2563eb"
              loading={loading}
            />
          </Grid>
          <Grid item xs={12} lg={4}>
            <RankedList
              title="Conexiones mas usadas"
              icon={<WifiTetheringRoundedIcon fontSize="small" />}
              rows={connectionData}
              color="#0d9488"
              loading={loading}
            />
          </Grid>
          <Grid item xs={12} lg={4}>
            <RankedList
              title="Estados de chat"
              icon={<TaskAltRoundedIcon fontSize="small" />}
              rows={statusData}
              valueLabel="chats"
              color="#f59e0b"
              loading={loading}
            />
          </Grid>
          <Grid item xs={12} lg={4}>
            <RankedList
              title="Tipos de mensaje"
              icon={<GraphicEqRoundedIcon fontSize="small" />}
              rows={typeData}
              color="#9333ea"
              loading={loading}
            />
          </Grid>
          <Grid item xs={12} lg={8}>
            <QueuePerformance rows={queues} loading={loading} />
          </Grid>
        </Grid>

        <ChartDrilldownModal
          open={drilldownOpen}
          datum={drilldownDatum}
          level={drilldownLevel}
          loading={drilldownLoading}
          onClose={() => setDrilldownOpen(false)}
          onFilterChange={handleDrilldownFilter}
        />
      </Stack>
    </Box>
  );
};

export default Dashboard;
