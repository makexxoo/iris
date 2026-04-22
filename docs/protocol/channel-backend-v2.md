# Channel-Backend Protocol V2

## 1. Scope

This document defines the mandatory protocol between iris and all backend adapters.
V2 is a one-shot upgrade and replaces legacy payload formats.

## 2. Envelope

All messages MUST use this envelope:

```json
{
  "version": 2,
  "type": "message|message_update",
  "timestamp": 1710000000000,
  "traceId": "optional-trace-id",
  "payload": {}
}
```

- `version`: fixed to `2`
- `type`: semantic message type
- `timestamp`: Unix ms
- `traceId`: optional distributed tracing id
- `payload`: business payload

## 3. iris -> backend (`type=message`)

Required payload fields:

- `messageId`
- `sessionId`
- `channel`
- `channelUserId` (platform native user id)
- `content`
- `context`

Example:

```json
{
  "version": 2,
  "type": "message",
  "timestamp": 1710000000000,
  "traceId": "msg-123",
  "payload": {
    "messageId": "msg-123",
    "sessionId": "session-abc",
    "channel": "feishu",
    "channelUserId": "ou_xxx",
    "content": { "type": "text", "text": "hello" },
    "context": {}
  }
}
```

## 4. backend -> iris (`type=message|message_update`)

Required payload fields:

- `channel`
- `channelUserId` (platform native user id)
- `content`

Optional payload fields:

- `sessionId`
- `requestId`
- `conversationId`

Example:

```json
{
  "version": 2,
  "type": "message",
  "timestamp": 1710000001234,
  "payload": {
    "channel": "feishu",
    "channelUserId": "ou_xxx",
    "sessionId": "session-abc",
    "requestId": "msg-123",
    "content": { "type": "text", "text": "hi" }
  }
}
```

## 5. Validation and rejection

iris rejects inbound backend messages when:

- envelope is not valid JSON
- `version` missing or not `2`
- `type` not in `message|message_update`
- `payload.channel` missing
- `payload.channelUserId` missing
- `payload.content` missing or malformed

Core error codes:

- `BACKEND_PROTOCOL_INVALID_JSON`
- `BACKEND_PROTOCOL_INVALID_ENVELOPE`
- `BACKEND_PROTOCOL_MISSING_VERSION`
- `BACKEND_PROTOCOL_INVALID_VERSION`
- `BACKEND_PROTOCOL_MISSING_TYPE`
- `BACKEND_PROTOCOL_INVALID_TYPE`
- `BACKEND_PROTOCOL_MISSING_PAYLOAD`
- `BACKEND_PROTOCOL_MISSING_CHANNEL`
- `BACKEND_PROTOCOL_MISSING_CHANNEL_USER_ID`
- `BACKEND_PROTOCOL_MISSING_CONTENT`
