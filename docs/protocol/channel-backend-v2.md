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

## 2.1 Single Message Body Rule

- `payload` MUST be a complete `IrisMessage` object for both directions.
- Legacy payload shapes (`messageId`, `requestId`, `conversationId` as protocol routing fields) are removed.
- Routing identity uses `payload.id` as request/message key, plus `payload.sessionId` and channel fields.

## 3. iris -> backend (`type=message`)

Required payload fields:

- `id`
- `sessionId`
- `channel`
- `channelUserId` (platform native user id)
- `content` (OpenAI-compatible content parts array)
- `timestamp`
- `raw` (optional but recommended)

Example:

```json
{
  "version": 2,
  "type": "message",
  "timestamp": 1710000000000,
  "traceId": "msg-123",
  "context": {},
  "payload": {
    "id": "msg-123",
    "sessionId": "session-abc",
    "channel": "feishu",
    "channelUserId": "ou_xxx",
    "content": [
      { "type": "text", "text": "hello" },
      {
        "type": "image_url",
        "image_url": {
          "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
          "detail": "input.png"
        }
      }
    ],
    "timestamp": 1710000000000,
    "raw": {}
  }
}
```

Base64 image rule:

- For inline image bytes, use `image_url.url = "data:<mime>;base64,<base64-data>"`.
- Example: `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...`

## 4. backend -> iris (`type=message|message_update`)

Required payload fields:

- `id`
- `sessionId`
- `channel`
- `channelUserId` (platform native user id)
- `content` (OpenAI-compatible content parts array)
- `timestamp`

Optional payload fields:

- `raw`

Example:

```json
{
  "version": 2,
  "type": "message",
  "timestamp": 1710000001234,
  "payload": {
    "id": "msg-123",
    "channel": "feishu",
    "channelUserId": "ou_xxx",
    "sessionId": "session-abc",
    "content": [
      { "type": "text", "text": "hi" },
      { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } }
    ],
    "timestamp": 1710000001234,
    "raw": {}
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
- `payload.id` or `payload.sessionId` missing
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
