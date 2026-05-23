import { createContext, useContext } from 'react';
import { useConnectionCountdowns } from '../hooks/useConnectionCountdowns.js';

const ConnectionCountdownContext = createContext(null);

export const ConnectionCountdownProvider = ({ children }) => {
  const value = useConnectionCountdowns();
  return <ConnectionCountdownContext.Provider value={value}>{children}</ConnectionCountdownContext.Provider>;
};

export const useConnectionCountdownsContext = () => {
  const ctx = useContext(ConnectionCountdownContext);
  if (!ctx) throw new Error('useConnectionCountdownsContext must be used within ConnectionCountdownProvider');
  return ctx;
};
