import pino from 'pino';
import { PluginContext } from '../message';
import { Plugin } from './types';

const logger = pino({ name: 'iris:plugin:logger' });

export class LoggerPlugin implements Plugin {
  readonly name = 'logger';

  async execute(ctx: PluginContext): Promise<void> {
    logger.info(
      {
        channel: ctx.message.channel,
        sessionId: ctx.message.sessionId,
        contentType: ctx.message.content.type,
      },
      'pipeline',
    );
  }
}
