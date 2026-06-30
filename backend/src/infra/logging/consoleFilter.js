const FILTER_INSTALLED = Symbol.for('whatssuite.consoleFilter.installed');

const sensitivePrefixes = [
  'Closing session:',
  'Opening session:',
  'Session already closed',
  'Session already open',
  'Closing open session in favor of incoming prekey bundle'
];

const shouldSuppress = (args) => {
  const first = args?.[0];
  return typeof first === 'string' && sensitivePrefixes.some((prefix) => first.startsWith(prefix));
};

if (!globalThis[FILTER_INSTALLED]) {
  globalThis[FILTER_INSTALLED] = true;

  ['info', 'warn', 'error'].forEach((method) => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (shouldSuppress(args)) return;
      original(...args);
    };
  });
}
