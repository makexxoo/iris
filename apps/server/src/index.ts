#!/usr/bin/env node
import pino from 'pino';
import { parseArgs } from 'node:util';
import {
  BackendAdapter,
  channelAdapterRegistry,
  createServer,
  loadConfig,
  LoggerPlugin,
  MessageEngine,
  PluginPipeline,
} from '@agent-iris/core';
import { FeishuAdapter } from '@agent-iris/channel-feishu';
import { WechatAdapter, type WechatChannelGroup } from '@agent-iris/channel-wechat';
import { OpenclawChannelBackend } from '@agent-iris/backend-openclaw-channel';
import { ClaudeCodeChannelBackend } from '@agent-iris/backend-claude-code-channel';
import { HermesBackend } from '@agent-iris/backend-hermes';
import { IrisBackend } from '@agent-iris/backend-iris';

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
      default:
        logger.warn({ plugin: pluginCfg.name }, 'unknown plugin, skipping');
    }
  }

  await pipeline.init();

  // --- Router ---
  const router = new MessageEngine(pipeline, config);

  // --- Backend adapters ---
  const attachableBackends: BackendAdapter[] = [];

  for (const instance of config.backends.openclaw?.instances ?? []) {
    if (instance.enabled === false) continue;
    const backend = new OpenclawChannelBackend({
      name: instance.name,
      timeoutMs: instance.timeoutMs,
      wsPath: instance.wsPath,
    });
    router.registerBackend(backend);
    attachableBackends.push(backend);
    logger.info(
      { backendType: 'openclaw', name: backend.name, wsPath: instance.wsPath },
      'backend registered',
    );
  }

  for (const instance of config.backends['claude-code']?.instances ?? []) {
    if (instance.enabled === false) continue;
    const backend = new ClaudeCodeChannelBackend({
      name: instance.name,
      timeoutMs: instance.timeoutMs,
      wsPath: instance.wsPath,
    });
    router.registerBackend(backend);
    attachableBackends.push(backend);
    logger.info(
      { backendType: 'claude-code', name: backend.name, wsPath: instance.wsPath },
      'backend registered',
    );
  }

  for (const instance of config.backends.hermes?.instances ?? []) {
    if (instance.enabled === false) continue;
    const backend = new HermesBackend({
      name: instance.name,
      timeoutMs: instance.timeoutMs,
      wsPath: instance.wsPath,
    });
    router.registerBackend(backend);
    attachableBackends.push(backend);
    logger.info(
      { backendType: 'hermes', name: backend.name, wsPath: instance.wsPath },
      'backend registered',
    );
  }

  for (const instance of config.backends.iris?.instances ?? []) {
    if (instance.enabled === false) continue;
    const backend = new IrisBackend({
      name: instance.name,
      timeoutMs: instance.timeoutMs,
      wsPath: instance.wsPath,
    });
    router.registerBackend(backend);
    attachableBackends.push(backend);
    logger.info(
      { backendType: 'iris', name: backend.name, wsPath: instance.wsPath },
      'backend registered',
    );
  }

  // --- Channel adapters (array form) ---

  // 顶级 wechat 配置 → 创建单例 WechatAdapter（注册 HTTP 路由）
  let wechatAdapter: WechatAdapter | undefined;
  if (config.wechat?.enabled !== false) {
    wechatAdapter = new WechatAdapter(config.wechat ?? {}, router.handle);
    channelAdapterRegistry.register(wechatAdapter);
    logger.info('wechat: global adapter created');
  }

  // 收集 wechat channel 分组，稍后在 HTTP server 启动前加载账号
  const wechatGroups: WechatChannelGroup[] = [];

  for (const channelCfg of config.channels) {
    if (channelCfg.enabled === false) continue;

    switch (channelCfg.type) {
      case 'feishu': {
        const feishu = new FeishuAdapter(
          { name: channelCfg.name, apps: channelCfg.apps },
          router.handle,
        );
        channelAdapterRegistry.register(feishu);
        logger.info({ name: channelCfg.name, type: channelCfg.type }, 'channel registered');
        break;
      }
      case 'telegram': {
        logger.warn({ name: channelCfg.name }, 'telegram channel not yet implemented, skipping');
        break;
      }
      case 'wechat': {
        if (!wechatAdapter) {
          logger.warn(
            { name: channelCfg.name },
            'wechat: global wechat module is disabled, skipping channel group',
          );
          break;
        }
        wechatGroups.push({
          name: channelCfg.name,
          enabled: channelCfg.enabled,
          accountIds: channelCfg.accountIds,
        });
        logger.info(
          { name: channelCfg.name, type: channelCfg.type },
          'wechat channel group queued',
        );
        break;
      }
      default: {
        logger.warn({ channel: channelCfg }, 'unknown channel type, skipping');
      }
    }
  }

  if (wechatAdapter && wechatGroups.length > 0) {
    await wechatAdapter.init(wechatGroups);
  }

  // --- HTTP server ---
  const server = createServer(router);

  channelAdapterRegistry.run(server);

  // Attach WS backends to the shared HTTP server (no separate port needed)
  for (const backend of attachableBackends) {
    backend.attach(server.server);
  }

  const port = config.server.port;
  await server.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'iris started');
}

main().catch((err) => {
  pino().error(err, 'fatal startup error');
  process.exit(1);
});
