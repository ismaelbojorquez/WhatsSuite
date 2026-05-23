import { useEffect, useState } from 'react';
import { Box, CssBaseline } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Sidebar from './Sidebar.jsx';
import { WhatsappSessionsProvider } from '../context/WhatsappSessionsContext.jsx';
import { ConnectionCountdownProvider } from '../context/ConnectionCountdownContext.jsx';
import NotificationHub from './NotificationHub.jsx';

const storageKey = 'whatssuite-sidebar-open';
// Mantener estos anchos sincronizados con Sidebar para que el margen del contenido coincida.
const SIDEBAR_WIDTH_OPEN = 260;
const SIDEBAR_WIDTH_COLLAPSED = 88;

const Layout = () => {
  const { user, initializing } = useAuth();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) setOpen(stored === 'true');
  }, []);

  if (initializing || !user) return null;

  const sidebarWidth = open ? SIDEBAR_WIDTH_OPEN : SIDEBAR_WIDTH_COLLAPSED;

  return (
    // Usamos un contenedor de pantalla completa con overflow oculto para que sólo
    // el área de contenido haga scroll; el sidebar queda fijo en el eje Y.
    <WhatsappSessionsProvider>
      <ConnectionCountdownProvider>
        <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden', bgcolor: 'background.default' }}>
          <CssBaseline />
          <Sidebar open={open} onToggle={() => setOpen((prev) => !prev)} />

          <Box
            component="main"
            sx={(theme) => ({
              flexGrow: 1,
              display: 'flex',
              flexDirection: 'column',
              height: '100vh',
              ml: `${sidebarWidth}px`,
              width: `calc(100% - ${sidebarWidth}px)`,
              minWidth: 0,
              transition: 'margin-left 0.25s ease, width 0.25s ease',
              backgroundColor: theme.semanticColors.background
            })}
          >
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                <Outlet />
              </Box>
            </Box>
            <NotificationHub />
          </Box>
        </Box>
      </ConnectionCountdownProvider>
    </WhatsappSessionsProvider>
  );
};

export default Layout;
