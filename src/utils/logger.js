const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;

function toConsole(method, args) {
  const fn = console?.[method] || console.log;
  fn('[VR]', ...args);
}

const logger = {
  debug(...args) {
    if (isDev) toConsole('debug', args);
  },
  info(...args) {
    toConsole('info', args);
  },
  warn(...args) {
    toConsole('warn', args);
  },
  error(...args) {
    toConsole('error', args);
  },
};

export default logger;
