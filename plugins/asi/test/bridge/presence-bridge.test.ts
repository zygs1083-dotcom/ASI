import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { BridgeDiscoverySchema, type BridgeServerMessage, BridgeServerMessageSchema } from '@asi/presence-protocol';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as AsiPlugin from '../../src/host/dsh/index.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

function maskClientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen = 4;
  else if (len > 65535) headerLen = 10;

  const mask = randomBytes(4);
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  mask.copy(frame, headerLen);
  for (let i = 0; i < len; i += 1) {
    frame[headerLen + 4 + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return frame;
}

interface RawWsTestClient {
  sendText(text: string): void;
  sendFragmentedText(partA: string, partB: string): void;
  nextMessage(timeoutMs?: number): Promise<BridgeServerMessage>;
  waitFor(predicate: (msg: BridgeServerMessage) => boolean, timeoutMs?: number): Promise<BridgeServerMessage>;
  close(): void;
}

async function openRawWsClient(opts: {
  port: number;
  path?: string;
  token?: string;
  origin?: string;
}): Promise<{ statusCode: number; client?: RawWsTestClient }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version': '13',
    };
    if (opts.token !== undefined) {
      headers.Authorization = `Bearer ${opts.token}`;
    }
    if (opts.origin !== undefined) {
      headers.Origin = opts.origin;
    }

    const req = request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path ?? '/ws',
      method: 'GET',
      headers,
    });

    req.on('response', (res) => {
      res.resume();
      resolve({ statusCode: res.statusCode ?? 0 });
    });

    req.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
      const queue: BridgeServerMessage[] = [];
      const waiters: Array<(msg: BridgeServerMessage) => void> = [];
      let buf = Buffer.from(head);

      const parseFrames = () => {
        while (buf.length >= 2) {
          const b0 = buf[0] ?? 0;
          const b1 = buf[1] ?? 0;
          const opcode = b0 & 0x0f;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x1) {
            const parsed = BridgeServerMessageSchema.parse(JSON.parse(payload.toString('utf8')));
            const waiter = waiters.shift();
            if (waiter) waiter(parsed);
            else queue.push(parsed);
          }
        }
      };

      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        parseFrames();
      });

      const nextMessage = (timeoutMs = 5000): Promise<BridgeServerMessage> => {
        const queued = queue.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resMsg, rejMsg) => {
          const timer = setTimeout(() => rejMsg(new Error('Timed out waiting for WS message')), timeoutMs);
          waiters.push((msg) => {
            clearTimeout(timer);
            resMsg(msg);
          });
        });
      };

      const waitFor = async (
        predicate: (msg: BridgeServerMessage) => boolean,
        timeoutMs = 5000,
      ): Promise<BridgeServerMessage> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const msg = await nextMessage(Math.max(100, deadline - Date.now()));
          if (predicate(msg)) return msg;
        }
        throw new Error('Timed out waiting for matching WS message');
      };

      const client: RawWsTestClient = {
        sendText: (text: string) => {
          socket.write(maskClientFrame(0x1, Buffer.from(text, 'utf8'), true));
        },
        sendFragmentedText: (partA: string, partB: string) => {
          socket.write(maskClientFrame(0x1, Buffer.from(partA, 'utf8'), false));
          socket.write(maskClientFrame(0x0, Buffer.from(partB, 'utf8'), true));
        },
        nextMessage,
        waitFor,
        close: () => {
          socket.destroy();
        },
      };

      parseFrames();
      resolve({ statusCode: 101, client });
    });

    req.on('error', reject);
    req.end();
  });
}

async function createMinimalAsiHost(
  storageRoot: string,
  demoWorkspace: string,
): Promise<{ root: Context; dispose: () => Promise<void> }> {
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(ToolsService);
  await root.plugin(SessionStore);
  await root.plugin(SkillRegistry);
  root.tools.setExecutor(new NativeToolExecutor(root));

  const sess = root.sessions.create(SessionId('sess-bridge-demo'), {
    meta: { cwd: demoWorkspace, isSeeded: false },
  });
  const agentsList: Agent[] = [];

  root.provide('agents', {
    list: () => agentsList,
    get: (id: string) => agentsList.find((a) => a.id === id),
    withoutInitiator: <T>(fn: () => T) => fn(),
  });
  root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
  root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
  root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
  root.provide('tokenMeter', { contextPressure: () => ({}) });
  root.provide('workspaceRegistry', {
    archivedSessionIds: [],
    create: async () => ({}),
    list: () => [{ id: 'ws-demo', path: demoWorkspace, sessionIds: [sess.id] }],
  });
  root.provide('profileContext', {
    name: 'desktop',
    dir: storageRoot,
    patchPath: '',
    installAnchor: '',
    cwd: demoWorkspace,
    home: storageRoot,
    startedBundles: ['asi'],
    overlays: [],
    telemetryDisabledEnv: undefined,
  });

  const fork = await root.plugin(AsiPlugin, {
    storageRoot,
    helperPath: join(storageRoot, 'nonexistent-helper'),
    intervalMs: 60_000,
    ecoIntervalMs: 120_000,
    fastIntervalMs: 3_600_000,
    slowIntervalMs: 7_200_000,
    enablePresenceBridge: true,
  });
  await fork.await();

  return {
    root,
    dispose: async () => {
      await fork.dispose();
    },
  };
}

describe('ASI Presence 127.0.0.1 authenticated neural bus bridge', () => {
  it('writes 0600 discovery file, enforces Bearer token & Origin checks, serves RPCs, streams events, and cleans up on dispose', {
    timeout: 45_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-presence-bridge-'));
    tempDirs.push(dir);
    const storageRoot = join(dir, 'asi');
    const demoWorkspace = join(dir, 'demo-repo');

    const root = await createMinimalAsiHost(storageRoot, demoWorkspace);
    const discoveryPath = join(storageRoot, 'presence-bridge.json');

    try {
      expect(existsSync(discoveryPath)).toBe(true);
      const discoveryStat = await stat(discoveryPath);
      expect(discoveryStat.mode & 0o777).toBe(0o600);

      const discovery = BridgeDiscoverySchema.parse(JSON.parse(await readFile(discoveryPath, 'utf8')));
      expect(discovery.host).toBe('127.0.0.1');
      expect(discovery.wsPath).toBe('/ws');
      expect(discovery.port).toBeGreaterThan(0);

      // 1. Security rejections: missing token, wrong token, evil Origin, bad path
      const noToken = await openRawWsClient({ port: discovery.port });
      expect(noToken.statusCode).toBe(401);

      const wrongToken = await openRawWsClient({ port: discovery.port, token: 'wrong-token' });
      expect(wrongToken.statusCode).toBe(401);

      const evilOrigin = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'https://evil.example.com',
      });
      expect(evilOrigin.statusCode).toBe(403);

      const fakeLoopbackOrigin = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'http://127.0.0.1.evil.example',
      });
      expect(fakeLoopbackOrigin.statusCode).toBe(403);

      const nullOrigin = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'null',
      });
      expect(nullOrigin.statusCode).toBe(403);

      const wrongPath = await openRawWsClient({
        port: discovery.port,
        path: '/other',
        token: discovery.token,
      });
      expect(wrongPath.statusCode).toBe(404);

      // 2. Valid authenticated connection
      const conn = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'http://127.0.0.1:5173',
      });
      expect(conn.statusCode).toBe(101);
      const client = conn.client;
      expect(client).toBeDefined();
      if (!client) return;

      const hello = await client.nextMessage();
      expect(hello.type).toBe('hello');
      if (hello.type === 'hello') {
        expect(hello.snapshot.connected).toBe(true);
        expect(hello.snapshot.needs.overallZone).toBe('comfortable');
      }

      // 3. Fragmented RFC 6455 ping frame -> pong
      const pingJson = JSON.stringify({ type: 'ping', at: Date.now() });
      client.sendFragmentedText(pingJson.slice(0, 10), pingJson.slice(10));
      const pong = await client.waitFor((m) => m.type === 'pong');
      expect(pong.type).toBe('pong');

      // 4. Create & recall long-term memory through shared vault RPC
      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-mem-create',
          method: 'memory.create',
          params: {
            kind: 'preference',
            title: '雪儿昵称偏好',
            content: '用户希望伴生数字人叫雪儿，参考小时候奶奶家的雪白小狗。',
            tags: ['xueer', 'persona'],
            pinned: true,
          },
        }),
      );
      const createRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-mem-create');
      expect(createRes.type === 'rpc.response' && createRes.ok).toBe(true);

      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-mem-recall',
          method: 'memory.recall',
          params: { query: '雪儿 小狗', limit: 5 },
        }),
      );
      const recallRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-mem-recall');
      expect(recallRes.type === 'rpc.response' && recallRes.ok).toBe(true);
      if (recallRes.type === 'rpc.response') {
        const result = recallRes.result as { hits: Array<{ title: string }> };
        expect(result.hits.some((h) => h.title.includes('雪儿'))).toBe(true);
      }

      // 5. Prospective intention create & list + ToM manual override + DSH delegate preview
      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-prosp-create',
          method: 'prospective.create',
          params: {
            title: '提醒喝水',
            instruction: '30 分钟后温柔提醒用户喝口水休息一下',
            triggerKind: 'time',
            delayMinutes: 30,
          },
        }),
      );
      const prospRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-prosp-create');
      expect(prospRes.type === 'rpc.response' && prospRes.ok).toBe(true);

      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-tom',
          method: 'tom.override',
          params: { state: 'deep_focus', durationMinutes: 30 },
        }),
      );
      const tomRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-tom');
      expect(tomRes.type === 'rpc.response' && tomRes.ok).toBe(true);
      if (tomRes.type === 'rpc.response') {
        const tom = tomRes.result as { state: string; shouldDefer: boolean };
        expect(tom.state).toBe('deep_focus');
        expect(tom.shouldDefer).toBe(true);
      }

      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-delegate',
          method: 'dsh.delegate_preview',
          params: { prompt: '帮我跑一下 pnpm check' },
        }),
      );
      const delRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-delegate');
      expect(delRes.type === 'rpc.response' && delRes.ok).toBe(true);

      // 5b. Unknown RPC method returns immediate ok:false error instead of hanging until timeout
      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-unknown-1',
          method: 'nonexistent.method',
        }),
      );
      const unknownRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-unknown-1', 1500);
      expect(unknownRes.type === 'rpc.response' && unknownRes.ok === false).toBe(true);
      if (unknownRes.type === 'rpc.response') {
        expect(unknownRes.error).toContain('Unsupported RPC method');
      }

      // 5c. memory.profile and prospective.list sanitize secret-like tokens before returning
      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-mem-secret',
          method: 'memory.create',
          params: {
            kind: 'pitfall',
            title: '密钥脱敏测试',
            content: '禁止把 sk-abcdefghijklmnopqrstuvwxyz12345678 发给外部',
            tags: ['security'],
          },
        }),
      );
      await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-mem-secret');

      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-profile',
          method: 'memory.profile',
          params: { limitPerKind: 4 },
        }),
      );
      const profileRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-profile');
      expect(profileRes.type === 'rpc.response' && profileRes.ok).toBe(true);
      expect(JSON.stringify(profileRes)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12345678');

      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-prosp-list',
          method: 'prospective.list',
          params: { limit: 10 },
        }),
      );
      const prospListRes = await client.waitFor((m) => m.type === 'rpc.response' && m.id === 'rpc-prosp-list');
      expect(prospListRes.type === 'rpc.response' && prospListRes.ok).toBe(true);

      client.close();
    } finally {
      await root.dispose();
    }

    // 6. Discovery file removed cleanly after plugin dispose
    expect(existsSync(discoveryPath)).toBe(false);
  });

  it('emits proactive help_card event on 0 -> 1 transition and avoids spurious alert when resolving one of multiple cards', {
    timeout: 45_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-presence-helpcard-'));
    tempDirs.push(dir);
    const storageRoot = join(dir, 'asi');
    const demoWorkspace = join(dir, 'demo-repo');

    const host = await createMinimalAsiHost(storageRoot, demoWorkspace);
    const discoveryPath = join(storageRoot, 'presence-bridge.json');

    try {
      const discovery = BridgeDiscoverySchema.parse(JSON.parse(await readFile(discoveryPath, 'utf8')));
      const conn = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'http://127.0.0.1:5173',
      });
      expect(conn.statusCode).toBe(101);
      const client = conn.client;
      expect(client).toBeDefined();
      if (!client) return;

      const hello = await client.nextMessage();
      expect(hello.type).toBe('hello');
      if (hello.type === 'hello') {
        expect(hello.snapshot.needs.openHelpCards).toHaveLength(0);
      }

      const proposeHelpCard = host.root.asiDrives.proposeHelpCard?.bind(host.root.asiDrives);
      const resolveHelpCards = host.root.asiDrives.resolveHelpCards?.bind(host.root.asiDrives);
      expect(proposeHelpCard).toBeDefined();
      expect(resolveHelpCards).toBeDefined();
      if (!proposeHelpCard || !resolveHelpCards) return;

      // Transition openHelpCards from 0 -> 1
      const card1 = await proposeHelpCard('asi-care', {
        driveKey: 'workspace_bloat',
        severity: 'uncomfortable',
        title: '发现闲置构建产物可回收',
        summary: 'demo-repo 下有过期 dist 缓存占用空间',
        actionKind: 'acknowledge',
        actionTarget: 'dist-cache-1',
      });

      const helpEvent1 = await client.waitFor((m) => m.type === 'event' && m.kind === 'help_card', 4000);
      expect(helpEvent1.type).toBe('event');
      if (helpEvent1.type === 'event') {
        expect(helpEvent1.kind).toBe('help_card');
        expect(helpEvent1.payload.count).toBe(1);
        const latest = helpEvent1.payload.latest as { id?: string; title?: string } | undefined;
        expect(latest?.id).toBe(card1.id);
        expect(latest?.title).toContain('闲置构建产物');
      }

      // Transition 1 -> 2 emits a second help_card event pointing to the newly added card
      const card2 = await proposeHelpCard('asi-care', {
        driveKey: 'repo_hygiene',
        severity: 'uncomfortable',
        title: '存在可清理的已合入 worktree',
        summary: '检测到干净已合并工作树',
        actionKind: 'acknowledge',
        actionTarget: 'wt-cleanup-2',
      });
      const helpEvent2 = await client.waitFor((m) => m.type === 'event' && m.kind === 'help_card', 4000);
      expect(helpEvent2.type).toBe('event');
      if (helpEvent2.type === 'event') {
        expect(helpEvent2.payload.count).toBe(2);
        const latest = helpEvent2.payload.latest as { id?: string } | undefined;
        expect(latest?.id).toBe(card2.id);
      }

      // Resolving card2 (2 -> 1) broadcasts updated snapshot but must NOT re-emit a spurious help_card alert
      await resolveHelpCards('asi-care', { driveKey: 'repo_hygiene' });
      const snapAfterResolve = await client.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.needs.openHelpCards.length === 1,
        4000,
      );
      expect(snapAfterResolve.type).toBe('snapshot');

      // Confirm via RPC that help.list reflects the single remaining open card and no extra help_card arrived
      client.sendText(JSON.stringify({ type: 'rpc.request', id: 'rpc-help-check', method: 'help.list' }));
      const seenBetween: BridgeServerMessage[] = [];
      const rpcRes = await client.waitFor((m) => {
        if (m.type === 'rpc.response' && m.id === 'rpc-help-check') return true;
        seenBetween.push(m);
        return false;
      }, 3000);
      expect(rpcRes.type === 'rpc.response' && rpcRes.ok).toBe(true);
      expect(seenBetween.some((m) => m.type === 'event' && m.kind === 'help_card')).toBe(false);

      client.close();
    } finally {
      await host.dispose();
    }
  });

  it('does not reset or swallow pending tom_changed and help_card semantic events when a second client connects concurrently', {
    timeout: 45_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-presence-concurrent-'));
    tempDirs.push(dir);
    const storageRoot = join(dir, 'asi');
    const demoWorkspace = join(dir, 'demo-repo');

    const host = await createMinimalAsiHost(storageRoot, demoWorkspace);
    const discoveryPath = join(storageRoot, 'presence-bridge.json');

    try {
      const discovery = BridgeDiscoverySchema.parse(JSON.parse(await readFile(discoveryPath, 'utf8')));
      const conn1 = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'http://127.0.0.1:5173',
      });
      expect(conn1.statusCode).toBe(101);
      const client1 = conn1.client;
      expect(client1).toBeDefined();
      if (!client1) return;

      const hello1 = await client1.nextMessage();
      expect(hello1.type).toBe('hello');
      if (hello1.type === 'hello') {
        expect(hello1.snapshot.tom.state).toBe('steady_flow');
        expect(hello1.snapshot.needs.openHelpCards).toHaveLength(0);
      }

      const proposeHelpCard = host.root.asiDrives.proposeHelpCard?.bind(host.root.asiDrives);
      expect(proposeHelpCard).toBeDefined();
      if (!proposeHelpCard) return;

      // Trigger BOTH a ToM state transition and a 0 -> 1 help card transition (queued inside the 250ms throttle window)
      client1.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-tom-concurrent',
          method: 'tom.override',
          params: { state: 'deep_focus', durationMinutes: 20 },
        }),
      );
      const card = await proposeHelpCard('asi-care', {
        driveKey: 'orphan_runtime',
        severity: 'uncomfortable',
        title: '发现孤儿开发服务端口',
        summary: '本地端口 5179 已闲置超过 2 小时',
        actionKind: 'acknowledge',
        actionTarget: 'port-5179',
      });

      // Immediately connect a second client BEFORE the 250ms throttled broadcast flushes!
      const conn2 = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'http://127.0.0.1:5179',
      });
      expect(conn2.statusCode).toBe(101);
      const client2 = conn2.client;
      expect(client2).toBeDefined();
      if (!client2) return;

      const hello2 = await client2.nextMessage();
      expect(hello2.type).toBe('hello');

      // Client 1 MUST still receive BOTH semantic events (`tom_changed` and `help_card`) without being reset/swallowed
      const collected: BridgeServerMessage[] = [];
      let sawTomChanged = false;
      let sawHelpCard = false;
      const deadline = Date.now() + 5000;
      while ((!sawTomChanged || !sawHelpCard) && Date.now() < deadline) {
        const msg = await client1.nextMessage(Math.max(200, deadline - Date.now()));
        collected.push(msg);
        if (msg.type === 'event' && msg.kind === 'tom_changed' && msg.payload.state === 'deep_focus') {
          sawTomChanged = true;
        }
        if (msg.type === 'event' && msg.kind === 'help_card') {
          const latest = msg.payload.latest as { id?: string } | undefined;
          if (latest?.id === card.id) {
            sawHelpCard = true;
          }
        }
      }

      expect(sawTomChanged).toBe(true);
      expect(sawHelpCard).toBe(true);

      // Subsequent transition after second client connected/closed also continues emitting normally for client 1
      client2.close();
      client1.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-tom-after',
          method: 'tom.override',
          params: { state: 'rapid_sprint', durationMinutes: 15 },
        }),
      );
      const nextTom = await client1.waitFor(
        (m) => m.type === 'event' && m.kind === 'tom_changed' && m.payload.state === 'rapid_sprint',
        4000,
      );
      expect(nextTom.type).toBe('event');

      client1.close();
    } finally {
      await host.dispose();
    }
  });

  it('syncs diff baselines on 0 -> 1 client connect so offline state changes in hello do not re-emit spurious events', {
    timeout: 45_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-presence-offline-sync-'));
    tempDirs.push(dir);
    const storageRoot = join(dir, 'asi');
    const demoWorkspace = join(dir, 'demo-repo');

    const host = await createMinimalAsiHost(storageRoot, demoWorkspace);
    const discoveryPath = join(storageRoot, 'presence-bridge.json');

    try {
      const discovery = BridgeDiscoverySchema.parse(JSON.parse(await readFile(discoveryPath, 'utf8')));
      const proposeHelpCard = host.root.asiDrives.proposeHelpCard?.bind(host.root.asiDrives);
      expect(proposeHelpCard).toBeDefined();
      if (!proposeHelpCard) return;

      // Create a help card while ZERO clients are connected
      const offlineCard = await proposeHelpCard('asi-care', {
        driveKey: 'workspace_bloat',
        severity: 'uncomfortable',
        title: '离线期间产生的求助卡',
        summary: '连接前就已存在的卡片',
        actionKind: 'acknowledge',
        actionTarget: 'offline-card-1',
      });

      // Now connect first client (0 -> 1) -> hello already includes offlineCard
      const conn = await openRawWsClient({
        port: discovery.port,
        token: discovery.token,
        origin: 'http://127.0.0.1:5173',
      });
      expect(conn.statusCode).toBe(101);
      const client = conn.client;
      expect(client).toBeDefined();
      if (!client) return;

      const hello = await client.nextMessage();
      expect(hello.type).toBe('hello');
      if (hello.type === 'hello') {
        expect(hello.snapshot.needs.openHelpCards.some((c) => c.id === offlineCard.id)).toBe(true);
      }

      // Trigger an unrelated memory creation so flushBroadcast() runs
      client.sendText(
        JSON.stringify({
          type: 'rpc.request',
          id: 'rpc-unrelated-mem',
          method: 'memory.create',
          params: {
            kind: 'episode',
            title: '无关记忆更新',
            content: '用来触发一次广播刷新',
            tags: ['sync'],
          },
        }),
      );

      // Wait until memory_updated arrives and verify NO spurious help_card was emitted for offlineCard
      const seen: BridgeServerMessage[] = [];
      await client.waitFor((m) => {
        seen.push(m);
        return m.type === 'event' && m.kind === 'memory_updated';
      }, 4000);
      expect(seen.some((m) => m.type === 'event' && m.kind === 'help_card')).toBe(false);

      // Subsequent genuine new help card while connected MUST still emit help_card normally
      const liveCard = await proposeHelpCard('asi-care', {
        driveKey: 'repo_hygiene',
        severity: 'uncomfortable',
        title: '在线期间新产生的求助卡',
        summary: '连接后产生的新卡片应正常推送',
        actionKind: 'acknowledge',
        actionTarget: 'live-card-2',
      });
      const liveHelpEv = await client.waitFor((m) => m.type === 'event' && m.kind === 'help_card', 4000);
      expect(liveHelpEv.type).toBe('event');
      if (liveHelpEv.type === 'event') {
        const latest = liveHelpEv.payload.latest as { id?: string } | undefined;
        expect(latest?.id).toBe(liveCard.id);
      }

      client.close();
    } finally {
      await host.dispose();
    }
  });
});
