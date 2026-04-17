import Fastify from 'fastify';
import { MessageEngine } from './engine';

export function createServer(_?: MessageEngine) {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({ status: 'ok' }));

  return server;
}
