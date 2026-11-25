import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface WsClientConnection {
  readonly id: number;
  sendText(text: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export interface LoopbackWsServerOptions {
  wsPath: string;
  token: string;
  port?: number;
  maxClients?: number;
  maxPayloadBytes?: number;
  onConnect: (client: WsClientConnection) => void;
  onMessage: (client: WsClientConnection, text: string) => void;
  onDisconnect: (client: WsClientConnection) => void;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'file:' || parsed.protocol === 'app:') return true;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    }
    return false;
  } catch {
    return false;
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(sha256(provided), sha256(expected));
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let headerLen = 2;
  if (length >= 126 && length <= 65535) {
    headerLen = 4;
  } else if (length > 65535) {
    headerLen = 10;
  }

  const frame = Buffer.allocUnsafe(headerLen + length);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (length < 126) {
    frame[1] = length;
  } else if (length <= 65535) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  payload.copy(frame, headerLen);
  return frame;
}

function encodeClosePayload(code: number, reason = ''): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf8');
  const buf = Buffer.allocUnsafe(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

function rejectUpgrade(socket: Duplex, statusCode: number, reason: string): void {
  if (!socket.destroyed && socket.writable) {
    socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
      socket.destroy();
    });
  } else {
    socket.destroy();
  }
}

/**
 * Minimal, strict RFC 6455 loopback-only WebSocket server built purely on Node.js
 * `node:http` and `node:crypto` (zero external dependencies, safe for esbuild bundling).
 */
export class LoopbackWsServer {
  private readonly options: LoopbackWsServerOptions;
  private readonly maxClients: number;
  private readonly maxPayloadBytes: number;
  private server: Server | null = null;
  private readonly clients = new Set<WsClientConnection>();
  private readonly sockets = new Set<Duplex>();
  private nextClientId = 1;
  private boundPort = 0;

  constructor(options: LoopbackWsServerOptions) {
    this.options = options;
    this.maxClients = options.maxClients ?? 8;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 256 * 1024;
  }

  get port(): number {
    return this.boundPort;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    const server = createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Upgrade Required');
    });

    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port ?? 0, '127.0.0.1');
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind loopback WebSocket server');
    }
    this.boundPort = address.port;
    return this.boundPort;
  }

  broadcastText(text: string): void {
    for (const client of this.clients) {
      client.sendText(text);
    }
  }

  async stop(): Promise<void> {
    for (const client of [...this.clients]) {
      client.close(1001, 'bridge shutting down');
    }
    this.clients.clear();

    for (const socket of [...this.sockets]) {
      socket.destroy();
    }
    this.sockets.clear();

    const srv = this.server;
    this.server = null;
    this.boundPort = 0;
    if (!srv) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve();
      };
      const guard = setTimeout(done, 250);
      guard.unref();
      srv.close(done);
      srv.closeIdleConnections?.();
      srv.closeAllConnections?.();
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const requestUrl = req.url ?? '';
    const pathname = requestUrl.split('?')[0] ?? '';
    if (req.method !== 'GET' || pathname !== this.options.wsPath) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (!isAllowedOrigin(req.headers.origin)) {
      rejectUpgrade(socket, 403, 'Forbidden Origin');
      return;
    }

    const providedToken = extractBearerToken(req);
    if (!tokenMatches(providedToken, this.options.token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    if (this.clients.size >= this.maxClients) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const wsKey = req.headers['sec-websocket-key'];
    const wsVersion = req.headers['sec-websocket-version'];
    const upgradeHeader = req.headers.upgrade;
    if (
      typeof wsKey !== 'string' ||
      !wsKey.trim() ||
      upgradeHeader?.toLowerCase() !== 'websocket' ||
      (wsVersion !== undefined && wsVersion !== '13')
    ) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    const acceptKey = createHash('sha1').update(`${wsKey.trim()}${WS_MAGIC_GUID}`, 'utf8').digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        '',
      ].join('\r\n'),
    );

    this.attachClient(socket, head);
  }

  private attachClient(socket: Duplex, initialHead: Buffer): void {
    this.sockets.add(socket);
    const id = this.nextClientId;
    this.nextClientId += 1;

    let closed = false;
    let rxBuffer: Buffer = initialHead.length > 0 ? Buffer.from(initialHead) : Buffer.alloc(0);
    let fragmentedChunks: Buffer[] | null = null;
    let fragmentedBytes = 0;

    const cleanup = (destroyNow = true) => {
      if (closed) {
        if (destroyNow && !socket.destroyed) {
          socket.destroy();
        }
        return;
      }
      closed = true;
      this.clients.delete(client);
      if (destroyNow && !socket.destroyed) {
        socket.destroy();
      }
      this.sockets.delete(socket);
      this.options.onDisconnect(client);
    };

    const sendRaw = (frame: Buffer) => {
      if (closed || socket.destroyed || !socket.writable) return;
      try {
        socket.write(frame);
      } catch {
        socket.destroy();
        cleanup(true);
      }
    };

    const client: WsClientConnection = {
      id,
      sendText: (text: string) => {
        sendRaw(encodeWsFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')));
      },
      ping: () => {
        sendRaw(encodeWsFrame(OPCODE_PING, Buffer.alloc(0)));
      },
      close: (code = 1000, reason = '') => {
        if (closed) return;
        // Write RFC 6455 CLOSE frame and let socket.end() flush it before destroying.
        sendRaw(encodeWsFrame(OPCODE_CLOSE, encodeClosePayload(code, reason)));
        cleanup(false);
        if (!socket.destroyed && socket.writable) {
          const timer = setTimeout(() => {
            if (!socket.destroyed) socket.destroy();
          }, 50);
          timer.unref();
          socket.end(() => {
            clearTimeout(timer);
            if (!socket.destroyed) socket.destroy();
          });
        } else if (!socket.destroyed) {
          socket.destroy();
        }
      },
    };

    const processBuffer = () => {
      while (!closed && rxBuffer.length >= 2) {
        const b0 = rxBuffer[0] ?? 0;
        const b1 = rxBuffer[1] ?? 0;
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (rsv !== 0) {
          client.close(1002, 'reserved bits must be zero');
          return;
        }

        if (!masked) {
          client.close(1002, 'client frames must be masked');
          return;
        }

        const isControl = opcode >= 0x8;
        if (isControl && (!fin || payloadLen > 125)) {
          client.close(1002, 'invalid control frame');
          return;
        }

        if (payloadLen === 126) {
          if (rxBuffer.length < offset + 2) return;
          payloadLen = rxBuffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (rxBuffer.length < offset + 8) return;
          const bigLen = rxBuffer.readBigUInt64BE(offset);
          if (bigLen > BigInt(this.maxPayloadBytes)) {
            client.close(1009, 'payload too large');
            return;
          }
          payloadLen = Number(bigLen);
          offset += 8;
        }

        if (payloadLen > this.maxPayloadBytes) {
          client.close(1009, 'payload too large');
          return;
        }

        const totalLen = offset + 4 + payloadLen;
        if (rxBuffer.length < totalLen) return;

        const maskKey = rxBuffer.subarray(offset, offset + 4);
        const maskedPayload = rxBuffer.subarray(offset + 4, totalLen);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = (maskedPayload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
        }

        rxBuffer = rxBuffer.subarray(totalLen);

        if (opcode === OPCODE_PING) {
          sendRaw(encodeWsFrame(OPCODE_PONG, unmasked));
          continue;
        }
        if (opcode === OPCODE_PONG) {
          continue;
        }
        if (opcode === OPCODE_CLOSE) {
          client.close(1000, 'closing');
          return;
        }

        if (opcode === OPCODE_TEXT) {
          if (fragmentedChunks !== null) {
            client.close(1002, 'unexpected text frame during fragmentation');
            return;
          }
          if (fin) {
            this.options.onMessage(client, unmasked.toString('utf8'));
          } else {
            fragmentedChunks = [unmasked];
            fragmentedBytes = unmasked.length;
          }
          continue;
        }

        if (opcode === OPCODE_CONTINUATION && fragmentedChunks) {
          fragmentedBytes += unmasked.length;
          if (fragmentedBytes > this.maxPayloadBytes) {
            client.close(1009, 'fragmented payload too large');
            return;
          }
          fragmentedChunks.push(unmasked);
          if (fin) {
            const combined = Buffer.concat(fragmentedChunks);
            fragmentedChunks = null;
            fragmentedBytes = 0;
            this.options.onMessage(client, combined.toString('utf8'));
          }
          continue;
        }

        // Unsupported opcode (binary or unexpected continuation)
        client.close(1003, 'unsupported frame');
        return;
      }
    };

    this.clients.add(client);

    socket.on('data', (chunk: Buffer) => {
      rxBuffer = rxBuffer.length === 0 ? chunk : Buffer.concat([rxBuffer, chunk]);
      processBuffer();
    });
    socket.on('close', () => cleanup(true));
    socket.on('end', () => cleanup(true));
    socket.on('error', () => {
      socket.destroy();
      cleanup(true);
    });

    this.options.onConnect(client);
    if (rxBuffer.length > 0) {
      processBuffer();
    }
  }
}
