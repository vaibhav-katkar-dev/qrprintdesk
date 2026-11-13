import { WebSocket } from 'ws';
import { FastifyInstance } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import { authenticateAgent } from './auth.js';

interface AgentSocket extends WebSocket {
  isAlive?: boolean;
  shopId?: string;
  agentId?: string;
}

export class WebSocketHub {
  private activeSockets: Map<string, AgentSocket> = new Map(); // shopId -> AgentSocket
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(private db: Db) {}

  public register(fastify: FastifyInstance): void {
    // Fastify websocket route
    fastify.get('/ws/agent', { websocket: true }, (connection, req) => {
      const socket = connection as unknown as AgentSocket;
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || (req.headers['x-agent-key'] as string);

      if (!token) {
        socket.close(4008, 'Authentication token required');
        return;
      }

      authenticateAgent(this.db, token).then(({ success, agent }) => {
        if (!success || !agent) {
          socket.close(4003, 'Invalid or revoked agent token');
          return;
        }

        const shopId = agent.shopId.toString();
        const agentId = agent._id.toString();

        // One active connection per shop: Newer connection replaces the old one
        const existing = this.activeSockets.get(shopId);
        if (existing && existing.readyState === WebSocket.OPEN) {
          existing.close(4001, 'Replaced by newer connection');
        }

        socket.isAlive = true;
        socket.shopId = shopId;
        socket.agentId = agentId;
        this.activeSockets.set(shopId, socket);

        socket.on('pong', () => {
          socket.isAlive = true;
        });

        socket.on('close', () => {
          if (this.activeSockets.get(shopId) === socket) {
            this.activeSockets.delete(shopId);
          }
        });

        socket.on('error', () => {
          if (this.activeSockets.get(shopId) === socket) {
            this.activeSockets.delete(shopId);
          }
        });

        // Send welcome / connected ack
        socket.send(JSON.stringify({ type: 'connected', shopId }));
      }).catch(() => {
        socket.close(4500, 'Server authentication error');
      });
    });

    // In-memory heartbeat every 30 seconds - NO DB writes
    this.pingInterval = setInterval(() => {
      for (const [shopId, socket] of this.activeSockets.entries()) {
        if (!socket.isAlive) {
          socket.terminate();
          this.activeSockets.delete(shopId);
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30000);
  }

  public isAgentConnected(shopId: string): boolean {
    const socket = this.activeSockets.get(shopId);
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  // Send compact hint only: { type: "job", id: jobId }
  public sendJobHint(shopId: string, jobId: string): boolean {
    const socket = this.activeSockets.get(shopId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'job', id: jobId }));
      return true;
    }
    return false;
  }

  public close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const socket of this.activeSockets.values()) {
      socket.close(1001, 'Server shutting down');
    }
    this.activeSockets.clear();
  }
}
