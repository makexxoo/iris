import { Client, Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'crypto';
import pino from 'pino';
import type { IrisMessage, MessageContentPart } from '@agent-iris/core';

const logger = pino({ name: 'channel-feishu:appconnection' });

export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
  /** 'feishu' for domestic China, 'lark' for international. Default: 'feishu' */
  domain?: 'feishu' | 'lark';
  /**
   * Controls which senders are allowed in group chats.
   * - 'open' (default): any sender is allowed
   * - 'allowlist': only senders listed in groupAllowFrom are allowed
   * - 'disabled': all group messages are blocked
   */
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  /** List of open_ids allowed to send in groups when groupPolicy='allowlist' */
  groupAllowFrom?: string[];
  /**
   * When true, the bot must be @-mentioned in group chats to respond.
   * Messages without a bot mention are silently dropped.
   */
  requireMention?: boolean;
  /** Pass streaming:true to the AI backend context */
  streaming?: boolean;
}

export class AppConnection {
  readonly appId: string;
  private client: Client;
  private wsClient: WSClient;
  private botOpenId: string | undefined;

  constructor(
    private channelType: string,
    private config: FeishuAppConfig,
    private onMessage: (msg: IrisMessage) => void,
    /** The channel instance name (e.g. 'feishu-main'). Used to populate message.channel. */
    private channelName: string = 'feishu',
  ) {
    this.appId = config.appId;
    const domain = config.domain === 'lark' ? Domain.Lark : Domain.Feishu;
    this.client = new Client({ appId: config.appId, appSecret: config.appSecret, domain });
    this.wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
      autoReconnect: true,
    });
  }

  private async fetchBotOpenId(): Promise<void> {
    try {
      const resp = await (this.client as any).bot.v3.bot.get({});
      this.botOpenId = resp?.data?.bot?.open_id ?? resp?.bot?.open_id;
      if (this.botOpenId) {
        logger.info({ appId: this.appId, botOpenId: this.botOpenId }, 'bot open_id 获取成功');
      } else {
        logger.warn({ appId: this.appId }, 'bot open_id 获取结果为空');
      }
    } catch (err) {
      logger.warn(
        { err, appId: this.appId },
        '获取 bot open_id 失败，requireMention 可能无法正常工作',
      );
    }
  }

  start(): void {
    // Fetch bot open_id upfront for mention detection
    if (this.config.requireMention) {
      this.fetchBotOpenId().catch(() => {});
    }

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const { message, sender } = data;
        logger.info(
          {
            appId: data.app_id,
            eventId: data.event_id,
            msgType: message.message_type,
            chatType: message.chat_type,
          },
          '收到飞书消息',
        );

        const openId = sender.sender_id?.open_id ?? '';
        if (!openId) return;

        const isGroup = message.chat_type === 'group';

        // --- groupPolicy gate (group only) ---
        if (isGroup) {
          const policy = this.config.groupPolicy ?? 'open';
          if (policy === 'disabled') {
            logger.debug(
              { appId: this.appId, chatId: message.chat_id },
              '群消息被 groupPolicy=disabled 拦截',
            );
            return;
          }
          if (policy === 'allowlist') {
            const allowed = (this.config.groupAllowFrom ?? []).includes(openId);
            if (!allowed) {
              logger.debug({ appId: this.appId, openId }, '群消息被 groupAllowFrom 名单拦截');
              return;
            }
          }
        }

        // --- requireMention gate (group only) ---
        if (isGroup && this.config.requireMention) {
          const mentions: Array<{ key: string; id?: { open_id?: string } }> =
            message.mentions ?? [];
          const mentioned = this.botOpenId
            ? mentions.some((m) => m.id?.open_id === this.botOpenId)
            : false;
          if (!mentioned) {
            logger.debug({ appId: this.appId, chatId: message.chat_id }, '群消息未 @bot，忽略');
            return;
          }
        }

        // --- Parse content ---
        const content = await this.parseContent(message);
        if (content.length === 0) return;

        const channelUserId = `${this.appId}:${openId}`;
        const mentions: Array<{ key: string; id?: { open_id?: string } }> = message.mentions ?? [];

        this.onMessage({
          id: data.event_id ?? randomUUID(),
          type: 'message',
          channelType: this.channelType,
          channelName: this.channelName,
          channelUserId,
          sessionId: `${this.channelName}:${channelUserId}`,
          content,
          timestamp: message.create_time ? parseInt(message.create_time, 10) : Date.now(),
          raw: {
            ...data,
            // Convenience fields used by reply()
            appId: this.appId,
            chatId: message.chat_id,
            chatType: message.chat_type,
            // Streaming flag forwarded to backend context
            streaming: this.config.streaming ?? false,
            // Mention list for downstream (strip bot self-mention)
            mentionOpenIds: mentions
              .map((m) => m.id?.open_id)
              .filter((id): id is string => Boolean(id) && id !== this.botOpenId),
          },
        });
      },
    });

    this.wsClient.start({ eventDispatcher: dispatcher }).catch((err) => {
      logger.error({ err, appId: this.appId }, 'feishu WS 连接错误');
    });

    logger.info({ appId: this.appId, domain: this.config.domain ?? 'feishu' }, 'feishu WS 已启动');
  }

  // ---------------------------------------------------------------------------
  // Content parsing
  // ---------------------------------------------------------------------------

  private async parseContent(message: any): Promise<MessageContentPart[]> {
    const msgType: string = message.message_type;
    const content: MessageContentPart[] = [];

    try {
      const parsed = JSON.parse(message.content ?? '{}');

      switch (msgType) {
        case 'text': {
          let text = parsed.text ?? '';
          // Strip @mention placeholder keys from the text body
          for (const m of message.mentions ?? []) {
            if (m.key) text = text.replace(new RegExp(escapeRegExp(m.key) + '\\s*', 'g'), '');
          }
          text = text.trim();
          if (text) content.push({ type: 'text', text });
          break;
        }

        case 'post': {
          const text = extractPostText(parsed);
          if (text) content.push({ type: 'text', text });
          break;
        }

        case 'image': {
          const imageKey: string | undefined = parsed.image_key;
          if (imageKey) {
            const att = await this.downloadResource(message.message_id, imageKey, 'image');
            if (att) content.push(att);
          }
          break;
        }

        case 'file': {
          const fileKey: string | undefined = parsed.file_key;
          if (fileKey) {
            const att = await this.downloadResource(
              message.message_id,
              fileKey,
              'file',
              parsed.file_name,
            );
            if (att) content.push(att);
          }
          break;
        }

        case 'audio': {
          const fileKey: string | undefined = parsed.file_key;
          if (fileKey) {
            const att = await this.downloadResource(message.message_id, fileKey, 'audio');
            if (att) content.push(att);
          }
          break;
        }

        case 'video': {
          const fileKey: string | undefined = parsed.file_key;
          if (fileKey) {
            const att = await this.downloadResource(message.message_id, fileKey, 'video');
            if (att) content.push(att);
          }
          break;
        }

        default:
          logger.debug({ msgType }, '暂不处理的消息类型，跳过');
      }
    } catch (err) {
      logger.warn({ err, msgType }, '解析消息内容失败');
    }

    return content;
  }

  private async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' | 'audio' | 'video',
    fileName?: string,
  ): Promise<MessageContentPart | null> {
    try {
      // Feishu SDK: image uses type='image', everything else uses type='file'
      const resourceType = type === 'image' ? 'image' : 'file';
      const response = await (this.client.im.v1.messageResource as any).get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType },
      });

      const buffer = await extractBuffer(response);
      if (!buffer) {
        logger.warn({ messageId, fileKey }, '无法从响应中提取媒体内容');
        return null;
      }

      const base64 = buffer.toString('base64');
      if (type === 'image') {
        return {
          type: 'image_url',
          image_url: {
            url: `data:image/*;base64,${base64}`,
            detail: fileName,
          },
        };
      }
      if (type === 'audio') {
        return { type: 'input_audio', input_audio: { data: base64 } };
      }
      return {
        type: 'file',
        file: {
          file_id: fileKey,
          filename: fileName,
          file_data: base64,
        },
      };
    } catch (err) {
      logger.error({ err, messageId, fileKey, type }, '下载媒体资源失败');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async sendToChat(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
  }

  async sendToOpenId(openId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
  }

  close(): void {
    this.wsClient.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract post (rich text) content as plain text. */
function extractPostText(post: Record<string, any>): string {
  // post format: { zh_cn: { title, content: [[{tag, text, ...}]] }, en_us: {...} }
  const lang: any = post?.zh_cn ?? post?.en_us ?? Object.values(post ?? {})[0];
  if (!lang) return '';

  const lines: string[] = [];
  if (lang.title) lines.push(lang.title);

  for (const paragraph of lang.content ?? []) {
    const parts: string[] = [];
    for (const el of paragraph ?? []) {
      if (el.tag === 'text') parts.push(el.text ?? '');
      else if (el.tag === 'a') parts.push(el.text ?? el.href ?? '');
      // skip @mention tags (at), images, etc.
    }
    lines.push(parts.join(''));
  }

  return lines.join('\n').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a Buffer from various Feishu SDK response formats.
 * The SDK may return Buffer, ArrayBuffer, ReadableStream, or an object
 * with .data / .getReadableStream() / .writeFile().
 */
async function extractBuffer(response: unknown): Promise<Buffer | null> {
  if (response == null) return null;
  if (Buffer.isBuffer(response)) return response;
  if (response instanceof ArrayBuffer) return Buffer.from(response);

  const resp = response as Record<string, any>;

  if (resp.data != null) {
    if (Buffer.isBuffer(resp.data)) return resp.data;
    if (resp.data instanceof ArrayBuffer) return Buffer.from(resp.data);
    if (typeof resp.data?.pipe === 'function') return streamToBuffer(resp.data);
  }

  if (typeof resp.getReadableStream === 'function') {
    const stream = await resp.getReadableStream();
    return streamToBuffer(stream);
  }

  if (typeof resp.pipe === 'function') {
    return streamToBuffer(resp as NodeJS.ReadableStream);
  }

  if (typeof (resp as any)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of resp as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  return null;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
