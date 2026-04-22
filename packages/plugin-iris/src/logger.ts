import pino from 'pino';

const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';

export const logger = pino({
  name: 'plugin-iris',
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
