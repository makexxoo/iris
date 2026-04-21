import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'http';
import { SessionRoutedWsBackend } from './session-routed-ws-backend';
import { SessionStateManager } from './session-state-manager';
import pino from 'pino';

const logger = pino({ name: 'backend-ws' });

export abstract class WebSocketSessionBackend extends SessionRoutedWsBackend<WebSocket> {
  private wss: WebSocketServer | null = null;

  protected path: string;

  protected constructor(timeoutMs: number, sessionStates: SessionStateManager, path: string) {
    super(timeoutMs, sessionStates);
    this.path = path;
  }

  attach(httpServer: Server<typeof IncomingMessage>) {
    this.attachWs(httpServer, this.path);
  }

  protected attachWs(httpServer: Server<typeof IncomingMessage>, path: string): void {
    this.wss = new WebSocketServer({ server: httpServer, path });

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

    this.onWsAttached(path);
  }

  protected closeWs(): void {
    this.clearState();
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
}
