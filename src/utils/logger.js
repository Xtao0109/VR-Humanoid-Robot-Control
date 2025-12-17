const isDev = typeof import.meta !== 'undefined' ? import.meta.env.DEV : false;

const noop = () => {};

const logger = {
  debug: isDev ? console.debug.bind(console) : noop,
  info: isDev ? console.info.bind(console) : noop,
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export default logger;
