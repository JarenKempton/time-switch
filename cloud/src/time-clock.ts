import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export const SNAPSHOT_HEADER = "x-time-switch-snapshot";

/**
 * Broadcast hub for live updates. It holds no data: the Worker reads and writes
 * D1, then hands this object an encoded message to fan out to every hibernated
 * WebSocket. The class keeps its original name so the namespace, and the legacy
 * SQLite storage the data migration reads, stay addressable.
 */
export class TimeClock extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const snapshot = request.headers.get(SNAPSHOT_HEADER);
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !snapshot
    ) {
      return new Response("A WebSocket upgrade is required.", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(snapshot);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(encoded: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        socket.close(1011, "Unable to deliver update");
      }
    }
  }

  webSocketMessage(): void {}

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Unexpected WebSocket error");
  }
}
