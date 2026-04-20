import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'http';
import { SessionRoutedWsBackend } from './session-routed-ws-backend';

export abstract class WebSocketSessionBackend extends SessionRoutedWsBackend<WebSocket> {
  private wss: WebSocketServer | null = null;

  protected constructor(timeoutMs: number, idleTtlMs: number) {
    super(timeoutMs, idleTtlMs);
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

  protected abstract onWsAttached(path: string): void;
  protected abstract onWsConnected(connection: WebSocket): void;
  protected abstract onWsDisconnected(connection: WebSocket): void;
  protected abstract onWsError(connection: WebSocket, err: unknown): void;
  protected abstract formatSendError(errorMessage: string): string;
}
