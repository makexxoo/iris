#!/usr/bin/env node
import pino from 'pino';
import { parseArgs } from 'node:util';
import {
  ChannelAdapter,
  createServer,
  loadConfig,
  LoggerPlugin,
  MessageEngine,
  PluginPipeline,
} from '@agent-iris/core';
import { FeishuAdapter } from '@agent-iris/channel-feishu';
import { OpenclawChannelBackend } from '@agent-iris/backend-openclaw-channel';
import { ClaudeCodeChannelBackend } from '@agent-iris/backend-claude-code-channel';
import { MemberInfoPlugin } from '@agent-iris/plugin-member-info';

const { values: argv } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (argv.help) {
  console.log('Usage: iris-server [--config <path>]');
  console.log('  -c, --config  Path to YAML config file (default: config/default.yaml)');
  process.exit(0);
}

const logger = pino({ name: 'iris' });

async function main() {
  const config = loadConfig(argv.config as string | undefined);

  // --- Plugin pipeline ---
  const pipeline = new PluginPipeline();

  for (const pluginCfg of config.plugins) {
    if (pluginCfg.enabled === false) continue;
    switch (pluginCfg.name) {
      case 'logger':
        pipeline.register(new LoggerPlugin());
        break;
      case 'member-info':
        pipeline.register(new MemberInfoPlugin(pluginCfg.options as { apiUrl: string }));
        break;
      default:
        logger.warn({ plugin: pluginCfg.name }, 'unknown plugin, skipping');
    }
  }

  await pipeline.init();

  // --- Router ---
  const router = new MessageEngine(pipeline, config);

  // --- Backend adapters ---
  let openclawChannelBackend: OpenclawChannelBackend | undefined;
  if (config.backends.openclaw?.enabled) {
    openclawChannelBackend = new OpenclawChannelBackend(config.backends.openclaw);
    router.registerBackend(openclawChannelBackend);
  }

  let claudeCodeChannelBackend: ClaudeCodeChannelBackend | undefined;
  if (config.backends['claude-code']?.enabled) {
    claudeCodeChannelBackend = new ClaudeCodeChannelBackend(config.backends['claude-code']);
    router.registerBackend(claudeCodeChannelBackend);
  }

  // --- Channel adapters (array form) ---
  const activeChannels: ChannelAdapter[] = [];

  for (const channelCfg of config.channels) {
    if (channelCfg.enabled === false) continue;

    switch (channelCfg.type) {
      case 'feishu': {
        const feishu = new FeishuAdapter(
          { name: channelCfg.name, apps: channelCfg.apps },
          router.handle,
        );
        router.registerChannel(feishu);
        activeChannels.push(feishu);
        logger.info({ name: channelCfg.name, type: channelCfg.type }, 'channel registered');
        break;
      }
      case 'telegram': {
        // TODO: import TelegramAdapter when available
        logger.warn({ name: channelCfg.name }, 'telegram channel not yet implemented, skipping');
        break;
      }
      case 'wechat': {
        // TODO: import WechatAdapter when available
        logger.warn({ name: channelCfg.name }, 'wechat channel not yet implemented, skipping');
        break;
      }
      default: {
        logger.warn({ channel: channelCfg }, 'unknown channel type, skipping');
      }
    }
  }

  // --- HTTP server ---
  const server = createServer(activeChannels, router);

  // Attach WS backends to the shared HTTP server (no separate port needed)
  openclawChannelBackend?.attach(server.server);
  claudeCodeChannelBackend?.attach(server.server);

  const port = config.server.port;
  await server.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'iris started');
}

main().catch((err) => {
  pino().error(err, 'fatal startup error');
  process.exit(1);
});
