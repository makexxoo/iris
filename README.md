# Iris

Iris Gateway 是一个AI 智能体网关。
它旨在通过统一的通信协议，将多渠道（飞书、Telegram 等）的即时通讯流，无缝对接至多种 AI 推理后端（Claude Code, OpenClaw 等）。

```
用户消息
  ↓
IRIS Server飞书 / Telegram / 微信）
  ↓
转发消息给（Claude Code / Openclaw）
  ↓
回复用户
```

## 功能特性

- **多渠道支持**：飞书（Feishu/Lark）长连接 WebSocket、Telegram（开发中）、微信（开发中）
- **多 AI 后端**：
  - `claude-code`：通过 WebSocket 将消息转发给 `plugin-claude-code` 进程，由 Claude Code CLI 处理
  - `openclaw`：通过 WebSocket 将消息转发给 Openclaw AI 处理
- **按 channel 路由**：每个 channel 实例有唯一 name，可在配置中按 name 将不同渠道分发到不同 AI 后端
- **插件管道**：在消息到达 AI 前进行预处理（注入成员信息、打印日志等），结果作为上下文传递给 AI
- **多实例 channel**：同一类型的 channel（如飞书）可以注册多个实例，各自路由到不同 backend
- **自动重连**：WebSocket 后端断线后自动重连


## 快速开始

### 第一步：创建配置文件

新建 `config.yaml`：

```yaml
server:
  port: 9527

plugins: []

channels:
  - type: feishu
    name: feishu-main          # 唯一实例名，用于路由
    enabled: true
    apps:
      - appId: cli_xxxxxxxxxx  # 飞书 App ID
        appSecret: your_app_secret
        domain: feishu          # feishu（国内）或 lark（海外）
        groupPolicy: open       # open | allowlist | disabled
        streaming: true
        requireMention: true    # 群聊中是否需要 @机器人
  - type: feishu
    name: feishu-2          # 唯一实例名，用于路由
    enabled: true
    apps:
      - appId: cli_xxxxxxxxxx  # 飞书 App ID
        appSecret: your_app_secret
        domain: feishu          # feishu（国内）或 lark（海外）
        groupPolicy: open       # open | allowlist | disabled
        streaming: true
        requireMention: true    # 群聊中是否需要 @机器人

backends:
  default: claude-code          # 未匹配路由时的默认后端
  routes:
    feishu-main: claude-code    # feishu-main 的消息转发到 claude-code
    feishu-2: openclaw          # feishu-2 的消息转发到 openclaw

  claude-code:
    enabled: true
```

### 第二步：启动 Iris 消息网关

```bash
npx @agent-iris/server@latest -c config.yaml
```

### 第三步：启动 Agent 端的插件


当前支持列表：

- [x] Claude Code
- [x] Openclaw
- [x] plugin-iris（自接入/外部项目集成）


#### Claude Code

在另一个终端，指定工作目录启动 Claude Code 进程，连接到上一步启动的网关，启动后在飞书发送消息，Claude code 就能开始干活了：

```bash
# 把当前目录作为 claude code 的工作目录
npx -y @agent-iris/claude-code-channel --iris-ws ws://127.0.0.1:9527/ws/claude-code
 
# 指定claude code工作目录
npx -y @agent-iris/claude-code-channel --iris-ws ws://127.0.0.1:9527/ws/claude-code --cwd /path/to/your/project
```

> **说明**
> - `--iris-ws`：Iris 网关的 WebSocket 地址，路径最后一段（`claude-code`）须与 `backends` 中的 key 一致
> - `--cwd`：Claude Code 执行命令时的工作目录，默认为当前目录

#### Openclaw

## License

MIT
