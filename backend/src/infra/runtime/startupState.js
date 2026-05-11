let phase = 'booting';
let ready = false;
let failed = false;
let errorMessage = null;
let updatedAt = new Date().toISOString();

const touch = () => {
  updatedAt = new Date().toISOString();
};

export const setStartupPhase = (nextPhase) => {
  phase = nextPhase;
  ready = false;
  failed = false;
  errorMessage = null;
  touch();
};

export const markStartupReady = () => {
  phase = 'ready';
  ready = true;
  failed = false;
  errorMessage = null;
  touch();
};

export const markStartupFailed = (error) => {
  phase = 'failed';
  ready = false;
  failed = true;
  errorMessage = error?.message || String(error || 'Unknown startup error');
  touch();
};

export const isStartupReady = () => ready;

export const getStartupState = () => ({
  phase,
  ready,
  failed,
  errorMessage,
  updatedAt
});
