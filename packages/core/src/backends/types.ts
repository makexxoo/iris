import { BackendRequest, MessageContent } from '../message';

export interface BackendAdapter {
  name: string;
  /** Send the enriched request to the AI backend; return the reply content */
  chat(req: BackendRequest): Promise<MessageContent>;
}
