import { BackendRequest, MessageContent } from '../message';

export interface BackendAdapter {
  name: string;
  /**
   * Send the enriched request to the AI backend.
   * - sync backend: return MessageContent and let engine reply
   * - async backend: return void and reply via channelAdapter directly
   */
  chat(req: BackendRequest): Promise<MessageContent | void>;
}
