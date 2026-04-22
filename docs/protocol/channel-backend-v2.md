# Channel-Backend Protocol V2

## 1. Scope

This document defines the mandatory protocol between iris and all backend adapters.
V2 is a one-shot upgrade and replaces legacy payload formats.

## 2. Message Body

All WS messages MUST be a complete `IrisMessage` object directly (no envelope).

```json
{
  "id": "msg-123",
  "type": "message",
  "sessionId": "session-abc",
  "channel": "feishu",
  "channelUserId": "ou_xxx",
  "content": [{ "type": "text", "text": "hello" }],
  "timestamp": 1710000000000,
  "raw": {},
  "context": {}
}
```

- `id`: unified request/message key
- `type`: `message | message_update`
- `sessionId`: backend session id
- `channel`: source channel name
- `channelUserId`: platform native user id
- `content`: OpenAI-compatible content parts array
- `timestamp`: Unix ms
- `raw`: original payload (recommended)
- `context`: optional business context

## 3. iris -> backend (`type=message`)

Required fields:

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
  "id": "msg-123",
  "type": "message",
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
  "raw": {},
  "context": {}
}
```

Base64 image rule:

- For inline image bytes, use `image_url.url = "data:<mime>;base64,<base64-data>"`.
- Example: `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...`

## 4. backend -> iris (`type=message|message_update`)

Required fields:

- `id`
- `sessionId`
- `channel`
- `channelUserId` (platform native user id)
- `content` (OpenAI-compatible content parts array)
- `timestamp`

Optional fields:

- `raw`

Example:

```json
{
  "type": "message",
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
```

## 5. Validation and rejection

iris rejects inbound backend messages when:

- message body is not valid JSON
- `type` not in `message|message_update`
- `channel` missing
- `channelUserId` missing
- `id` or `sessionId` missing
- `content` missing or malformed

Core error codes:

- `BACKEND_PROTOCOL_INVALID_JSON`
- `BACKEND_PROTOCOL_MISSING_TYPE`
- `BACKEND_PROTOCOL_INVALID_TYPE`
- `BACKEND_PROTOCOL_MISSING_CHANNEL`
- `BACKEND_PROTOCOL_MISSING_CHANNEL_USER_ID`
- `BACKEND_PROTOCOL_MISSING_CONTENT`
