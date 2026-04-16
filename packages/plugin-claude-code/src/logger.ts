import pino from 'pino';

export const logger = pino({
  name: 'claude-code-channel',
  level: process.env.LOG_LEVEL ?? 'debug',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname,name',
    },
  },
});
