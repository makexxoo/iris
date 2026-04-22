# plugin-iris 集成指南

`plugin-iris` 是一个通用的 iris backend 协议客户端，适合两类场景：

- 在本仓库中“自己接自己”（快速联调）
- 在外部项目中接入 iris，按自定义逻辑处理消息并回传

## 1. 协议前提

`plugin-iris` 对接 `backend: iris`（WS），使用 V2 协议：

- 入站（iris -> plugin）：`type=message`
- 回传（plugin -> iris）：`type=message|message_update`
- payload 必须是完整 `IrisMessage`（`id/channel/channelUserId/sessionId/content/timestamp`）

## 2. 自接入自回复（Echo）

### 2.1 iris 服务端配置

在服务端配置中启用 `iris` backend 实例，并把目标 channel 路由到它：

```yaml
backends:
  default: iris-default
  routes:
    feishu-main: iris-default
  iris:
    instances:
      - name: iris-default
        enabled: true
        # wsPath: /ws/iris
```

### 2.2 启动 plugin-iris

```bash
npx -y @agent-iris/plugin-iris --iris-ws ws://127.0.0.1:9527/ws/iris --mode echo --prefix "[echo] "
```

收到消息后会原样回显（加前缀），用于验证通道、路由、会话是否全链路正确。

## 3. 外部项目代码接入

在你的 Node.js 项目安装：

```bash
npm i @agent-iris/plugin-iris
```

示例：

```ts
import { IrisPluginClient } from '@agent-iris/plugin-iris';

const client = new IrisPluginClient({
  irisWs: 'ws://127.0.0.1:9527/ws/iris',
  reconnectDelayMs: 5000,
  handler: async (msg) => {
    const input = msg.content.text ?? '';
    const answer = `external-app reply: ${input}`;
    return { type: 'text', text: answer };
  },
});

client.start();
```

`handler` 入参包含：

- `sessionId`
- `requestId`（即入站 `IrisMessage.id`）
- `channel`
- `channelUserId`
- `content`
- `context`

返回值可为：

- 字符串（自动转成 `{ type: 'text', text }`）
- 标准 `content` 对象
- `null/undefined`（不回传）

## 4. 对接建议

- 把你的业务会话主键绑定到 `sessionId`，保证上下文连续
- 当需要流式展示时，先发 `message_update`，结束时再发 `message`
- `channelUserId` 必须使用渠道原生用户 ID（不要二次编码）
