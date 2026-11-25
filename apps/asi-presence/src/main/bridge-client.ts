import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompanionBridgeAdapter } from '@asi/omni-router';
import {
  BRIDGE_FILE_NAME,
  type BridgeDiscovery,
  BridgeDiscoverySchema,
  type BridgeMemoryItem,
  type BridgeRpcMethod,
  type BridgeServerMessage,
  BridgeServerMessageSchema,
  type BridgeSnapshot,
  createOfflineBridgeSnapshot,
} from '@asi/presence-protocol';
import WebSocket from 'ws';

export interface BridgeClientOptions {
  /** Path to `presence-bridge.json` (defaults to `~/.dsh/data/asi/presence-bridge.json`). */
  discoveryPath?: string;
  reconnectIntervalMs?: number;
  rpcTimeoutMs?: number;
}

export interface BridgeClientEvent {
  kind: string;
  at: number;
  payload: Record<string, unknown>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Resilient local loopback client connecting ASI Presence to the DSH `asi` plugin bridge.
 * Authenticates via `Authorization: Bearer <token>` read from `0600` `presence-bridge.json`
 * and degrades gracefully to standalone offline companion mode when DSH is not running.
 */
export class PresenceBridgeClient implements CompanionBridgeAdapter {
  readonly discoveryPath: string;
  private readonly reconnectIntervalMs: number;
  private readonly rpcTimeoutMs: number;
  private ws: WebSocket | null = null;
  private snapshot: BridgeSnapshot = createOfflineBridgeSnapshot();
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingRpcs = new Map<string, PendingRpc>();
  private readonly snapshotListeners = new Set<(snap: BridgeSnapshot) => void>();
  private readonly eventListeners = new Set<(ev: BridgeClientEvent) => void>();

  constructor(options: BridgeClientOptions = {}) {
    this.discoveryPath =
      options.discoveryPath ?? process.env.ASI_BRIDGE_FILE ?? join(homedir(), '.dsh', 'data', 'asi', BRIDGE_FILE_NAME);
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 2500;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 6000;
  }

  getSnapshot(): BridgeSnapshot {
    return this.snapshot;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.snapshot.connected;
  }

  subscribeSnapshot(listener: (snap: BridgeSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  subscribeEvents(listener: (ev: BridgeClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  start(): void {
    this.stopped = false;
    void this.tryConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.rejectAllPending(new Error('Bridge client stopped'));
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.terminate();
        setTimeout(resolve, 150);
      });
    }
  }

  async callRpc<T = unknown>(method: BridgeRpcMethod, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('DSH 神经总线当前未连接（处于离线独立陪伴模式）');
    }
    const id = `rpc_${randomUUID().slice(0, 10)}`;
    const payload = JSON.stringify({
      type: 'rpc.request',
      id,
      method,
      ...(params ? { params } : {}),
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`Bridge RPC ${method} timed out`));
      }, this.rpcTimeoutMs);

      this.pendingRpcs.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.ws?.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRpcs.delete(id);
          reject(err);
        }
      });
    });
  }

  async recallMemory(query: string, limit = 5): Promise<BridgeMemoryItem[]> {
    if (!this.isConnected()) return [];
    const res = await this.callRpc<{ hits?: BridgeMemoryItem[] }>('memory.recall', {
      query,
      limit,
      strengthen: true,
    });
    return Array.isArray(res.hits) ? res.hits : [];
  }

  private emitSnapshot(next: BridgeSnapshot): void {
    this.snapshot = next;
    for (const listener of this.snapshotListeners) {
      listener(next);
    }
  }

  private emitEvent(ev: BridgeClientEvent): void {
    for (const listener of this.eventListeners) {
      listener(ev);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, this.reconnectIntervalMs);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRpcs.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRpcs.delete(id);
    }
  }

  private async readDiscovery(): Promise<BridgeDiscovery | null> {
    try {
      const raw = await readFile(this.discoveryPath, 'utf8');
      return BridgeDiscoverySchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const discovery = await this.readDiscovery();
    if (!discovery || this.stopped) {
      if (this.snapshot.connected) {
        this.emitSnapshot(createOfflineBridgeSnapshot());
      }
      this.scheduleReconnect();
      return;
    }

    const url = `ws://${discovery.host}:${discovery.port}${discovery.wsPath}`;
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${discovery.token}`,
        Origin: 'http://127.0.0.1',
      },
      handshakeTimeout: 3000,
    });
    this.ws = socket;

    socket.on('open', () => {
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
        }
      }, 20_000);
    });

    socket.on('message', (data) => {
      let msg: BridgeServerMessage;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        msg = BridgeServerMessageSchema.parse(JSON.parse(text));
      } catch {
        return;
      }

      if (msg.type === 'hello' || msg.type === 'snapshot') {
        this.emitSnapshot(msg.snapshot);
        return;
      }
      if (msg.type === 'event') {
        this.emitEvent({ kind: msg.kind, at: msg.at, payload: msg.payload });
        return;
      }
      if (msg.type === 'rpc.response') {
        const pending = this.pendingRpcs.get(msg.id);
        if (!pending) return;
        this.pendingRpcs.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error ?? 'RPC error'));
        }
      }
    });

    const handleDisconnect = () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.rejectAllPending(new Error('Bridge connection closed'));
      if (this.snapshot.connected) {
        this.emitSnapshot(createOfflineBridgeSnapshot());
      }
      this.scheduleReconnect();
    };

    socket.on('close', handleDisconnect);
    socket.on('error', () => {
      // `close` event always follows error and triggers reconnect cleanly
    });
  }
}
