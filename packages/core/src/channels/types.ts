import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IrisMessage } from '../message';

export interface ChannelAdapter {
  type: string;
  name: string;

  support(message: IrisMessage): boolean;

  /**
   * Register webhook route(s) on the Fastify server, or start long-lived connections
   * (e.g. WebSocket) that feed messages into the router.
   */
  register(server: FastifyInstance): void;
  /**
   * Parse the inbound webhook request into a canonical IrisMessage.
   * Only required for HTTP webhook-based channels; WS-based channels omit this.
   * Return null to silently ignore the request (e.g. verification pings).
   */
  parse?(req: FastifyRequest, reply: FastifyReply): Promise<IrisMessage | null>;
  /** Send the AI reply back to the user via the channel's API (uses original message context) */
  reply(message: IrisMessage): Promise<void>;
}
