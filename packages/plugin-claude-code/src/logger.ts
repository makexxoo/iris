import pino from 'pino';

// pino-pretty uses worker_threads + dynamic require, which breaks when bundled.
// Only enable it when running directly from source (dev mode).
const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';

export const logger = pino({
  name: 'claude-code-channel',
  level: process.env.LOG_LEVEL ?? 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,name',
          },
        },
      }
    : {}),
});
