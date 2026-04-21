import { BackendRequest, MessageContent } from '../message';
import type { IncomingMessage, Server } from 'http';

export interface BackendAdapter {
  name: string;
  /**
   * Send the enriched request to the AI backend.
   * - sync backend: return MessageContent and let engine reply
   * - async backend: return void and reply via channelAdapter directly
   */
  chat(req: BackendRequest): Promise<MessageContent | void>;

  /**
   * Attach this backend's WS handler to an existing HTTP server.
   * Call this after the Fastify server is created, before listen().
   */
  attach(httpServer: Server<typeof IncomingMessage>): void;
}
