import { randomUUID, createHash } from 'crypto';
import { parseStringPromise } from 'xml2js';
import axios from 'axios';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IrisMessage, ChannelAdapter, MessageEngine } from '@agent-iris/core';

interface WechatConfig {
  token: string;
  appId: string;
  appSecret: string;
  encodingAESKey: string;
}

interface WechatTextMessage {
  xml: {
    ToUserName: [string];
    FromUserName: [string];
    CreateTime: [string];
    MsgType: [string];
    Content: [string];
    MsgId: [string];
  };
}

let accessToken = '';
let accessTokenExpiry = 0;

export class WechatAdapter implements ChannelAdapter {
  readonly name = 'wechat';

  constructor(
    private config: WechatConfig,
    private router: MessageEngine,
  ) {}

  register(server: FastifyInstance): void {
    server.get('/webhook/wechat', async (req: FastifyRequest, reply: FastifyReply) => {
      const { signature, timestamp, nonce, echostr } = req.query as Record<string, string>;
      if (this.verifySignature(timestamp, nonce, signature)) {
        reply.send(echostr);
      } else {
        reply.status(403).send('forbidden');
      }
    });

    server.post('/webhook/wechat', async (req: FastifyRequest, reply: FastifyReply) => {
      const message = await this.parse(req, reply);
      if (message) {
        setImmediate(() => this.router.handle(message));
      }
      reply.type('application/xml').send('<xml></xml>');
    });
  }

  async parse(req: FastifyRequest, _reply: FastifyReply): Promise<IrisMessage | null> {
    const rawBody = (req.body as string | Buffer).toString('utf8');

    let parsed: WechatTextMessage;
    try {
      parsed = (await parseStringPromise(rawBody)) as WechatTextMessage;
    } catch {
      return null;
    }

    const { MsgType, Content, FromUserName, CreateTime } = parsed.xml;
    if (MsgType[0] !== 'text') return null;

    const userId = FromUserName[0];
    const text = Content[0];
    const ts = parseInt(CreateTime[0], 10) * 1000;

    return {
      id: randomUUID(),
      channel: 'wechat',
      channelUserId: userId,
      sessionId: `wechat:${userId}`,
      content: { type: 'text', text },
      timestamp: ts,
      raw: parsed,
    };
  }

  async reply(message: IrisMessage, text: string): Promise<void> {
    const raw = message.raw as WechatTextMessage;
    const toUser = raw.xml.FromUserName[0];
    await this.sendWechatMessage(toUser, text);
  }

  async replyToUser(channelUserId: string, text: string): Promise<void> {
    await this.sendWechatMessage(channelUserId, text);
  }

  private async sendWechatMessage(toUser: string, text: string): Promise<void> {
    const token = await this.getAccessToken();
    await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`,
      {
        touser: toUser,
        msgtype: 'text',
        text: { content: text },
      },
    );
  }

  private verifySignature(timestamp: string, nonce: string, signature: string): boolean {
    const arr = [this.config.token, timestamp, nonce].sort();
    const hash = createHash('sha1').update(arr.join('')).digest('hex');
    return hash === signature;
  }

  private async getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < accessTokenExpiry) return accessToken;

    const res = await axios.get<{ access_token: string; expires_in: number }>(
      'https://api.weixin.qq.com/cgi-bin/token',
      {
        params: {
          grant_type: 'client_credential',
          appid: this.config.appId,
          secret: this.config.appSecret,
        },
      },
    );

    accessToken = res.data.access_token;
    accessTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return accessToken;
  }
}
