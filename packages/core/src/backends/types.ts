import { BackendRequest } from '../message';
import type { IncomingMessage, Server } from 'http';

export interface BackendAdapter {
  name: string;
  /**
   * Send the enriched request to the AI backend.
   * Backends are async-only: they acknowledge delivery and send replies later via channelAdapter.
   */
  chat(req: BackendRequest): Promise<void>;

  /**
   * Attach this backend's WS handler to an existing HTTP server.
   * Call this after the Fastify server is created, before listen().
   */
  attach(httpServer: Server<typeof IncomingMessage>): void;
}
