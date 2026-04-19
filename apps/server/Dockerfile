# 在仓库根目录执行（需要整仓 workspace 以安装依赖并打包）：
#   docker build -f apps/server/Dockerfile -t agent-iris-server .

# syntax=docker/dockerfile:1

FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY apps/server ./apps/server
COPY packages ./packages

RUN bun install --frozen-lockfile

WORKDIR /app/apps/server
RUN bun run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S iris && adduser -u 1001 -S -G iris iris

COPY --from=builder --chown=iris:iris /app/apps/server/package.json ./
COPY --from=builder --chown=iris:iris /app/apps/server/dist/index.js ./dist/index.js

USER iris

EXPOSE 9527

CMD ["node", "dist/index.js", "-c", "/app/config/server.yaml"]
