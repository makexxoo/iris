import type { IrisMessage } from '@agent-iris/protocol';

export interface IrisMessageHandler {
  (message: IrisMessage): Promise<void> | void;
}
