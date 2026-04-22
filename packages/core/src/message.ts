import { ChannelAdapter } from './channels/types';
export {
  extractTextFromContentParts,
  type MessageType,
  type IrisMessage,
  type MessageContentPart,
} from '@agent-iris/protocol';
import type { IrisMessage } from '@agent-iris/protocol';

/** Context that flows through the plugin pipeline */
export interface PluginContext {
  message: IrisMessage;
  /** Plugins write business data here; all data is forwarded to the AI backend */
  business: Record<string, unknown>;
}

/** Request sent to an AI backend */
export interface BackendRequest {
  message: IrisMessage;

  /**
   * Current channel adapter. Async backends can call channelAdapter.reply()
   * directly when the downstream reply arrives.
   */
  channelAdapter: ChannelAdapter;
}
