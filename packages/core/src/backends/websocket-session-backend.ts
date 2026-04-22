import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { SessionRoutedWsBackend } from './session-routed-ws-backend';
import pino from 'pino';

const logger = pino({ name: 'backend-ws' });

export abstract class WebSocketSessionBackend extends SessionRoutedWsBackend<WebSocket> {
  private wss: WebSocketServer | null = null;
  private httpServer: Server<typeof IncomingMessage> | null = null;
  private upgradeHandler:
    | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;

  protected path: string;

  protected constructor(timeoutMs: number, path: string) {
    super(timeoutMs);
    this.path = path;
  }

  attach(httpServer: Server<typeof IncomingMessage>) {
    this.attachWs(httpServer, this.path);
  }

  protected attachWs(httpServer: Server<typeof IncomingMessage>, path: string): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer = httpServer;

    this.wss.on('connection', (ws) => {
      this.registerConnection(ws);
      this.onWsConnected(ws);

      ws.on('message', (raw) => {
        void this.handleInboundRaw(raw.toString(), ws);
      });

      ws.on('close', () => {
        this.unregisterConnection(ws);
        this.onWsDisconnected(ws);
      });

      ws.on('error', (err) => {
        this.unregisterConnection(ws);
        this.onWsError(ws, err);
      });
    });

    this.upgradeHandler = (request, socket, head) => {
      if (!this.wss) return;
      const url = request.url ?? '';
      const pathname = url.split('?')[0] ?? '';
      if (pathname !== path) return;
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    };
    httpServer.on('upgrade', this.upgradeHandler);

    this.onWsAttached(path);
  }

  protected closeWs(): void {
    this.clearState();
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off('upgrade', this.upgradeHandler);
    }
    this.upgradeHandler = null;
    this.httpServer = null;
    this.wss?.close();
    this.wss = null;
  }

  protected isWsAttached(): boolean {
    return this.wss !== null;
  }

  protected isConnectionOpen(connection: WebSocket): boolean {
    return connection.readyState === WebSocket.OPEN;
  }

  protected sendPayload(connection: WebSocket, payload: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      connection.send(payload, (err) => {
        if (err) {
          reject(new Error(this.formatSendError(err.message)));
          return;
        }
        resolve();
      });
    });
  }

  protected onWsAttached(path: string): void {
    logger.info({ path, name: this.name }, `WS handler attached`);
  }
  protected onWsConnected(_connection: WebSocket): void {
    logger.info({ name: this.name }, 'plugin connected');
  }
  protected onWsDisconnected(_connection: WebSocket): void {
    logger.info({ name: this.name }, 'plugin disconnected');
  }
  protected onWsError(_connection: WebSocket, err: unknown): void {
    logger.warn({ name: this.name, err }, 'plugin WS error');
  }
  protected formatSendError(errorMessage: string): string {
    return `[${this.name}]: failed to send message: ${errorMessage}`;
  }

  protected noConnectionErrorMessage(): string {
    if (!this.isWsAttached()) {
      return `${this.name}: WS server not attached — call attach() before sending messages`;
    }
    return `${this.name}: no connected plugin-${this.name} instance — is it running?`;
  }
  close(): void {
    this.closeWs();
  }
}
