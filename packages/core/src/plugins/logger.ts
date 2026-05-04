import pino from 'pino';
import { PluginContext, extractTextFromContentParts } from '../message';
import { Plugin } from './types';

const logger = pino({ name: 'iris:plugin:logger' });

export class LoggerPlugin implements Plugin {
  readonly name = 'logger';

  async execute(ctx: PluginContext): Promise<void> {
    logger.info(
      {
        channelType: ctx.message.channelType,
        channelName: ctx.message.channelName,
        sessionId: ctx.message.sessionId,
        text: extractTextFromContentParts(ctx.message.content),
      },
      'pipeline',
    );
  }
}
