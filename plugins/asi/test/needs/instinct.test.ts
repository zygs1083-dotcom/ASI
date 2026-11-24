import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { evaluateNeeds } from '../../src/needs/host/evaluator.js';
import { defaultEndpointProbe, InstinctController } from '../../src/needs/host/instinct.js';
import { createMockSenseService, fact, makeSnapshot, T0 } from './fixtures.js';

describe('InstinctController 零 Token 本能反射', () => {
  it('低电量未插电立即切入 eco 降频，插电并恢复舒适后回到 normal', async () => {
    const sense = createMockSenseService();
    const probe = vi.fn(async () => true);
    const instinct = new InstinctController(sense, probe);

    const lowSnap = makeSnapshot({ now: T0 });
    lowSnap.state.self.body.battery = fact({ percent: 14, charging: false, powerState: 'battery' });
    const evalLow = evaluateNeeds({ snapshot: lowSnap, modelConnectivity: 'online', stuckJobCount: 0 });

    const r1 = await instinct.reconcile(lowSnap, evalLow.needs, false);
    expect(r1.powerChanged).toMatchObject({ from: 'normal', to: 'eco' });
    expect(sense.getSettings().powerMode).toBe('eco');

    // 电量回升到 35%（仍处于回滞驱动中 driveActive=true）时不提前退出 eco
    const midSnap = makeSnapshot({ now: T0 + 10_000, settings: sense.getSettings() });
    midSnap.state.self.body.battery = fact({ percent: 35, charging: false, powerState: 'battery' });
    const evalMid = evaluateNeeds({
      snapshot: midSnap,
      modelConnectivity: 'online',
      stuckJobCount: 0,
      previous: { energy: evalLow.needs.energy },
    });
    await instinct.reconcile(midSnap, evalMid.needs, false);
    expect(sense.getSettings().powerMode).toBe('eco');

    // 插上电源恢复舒适区 → 切回 normal
    const okSnap = makeSnapshot({ now: T0 + 20_000, settings: sense.getSettings() });
    okSnap.state.self.body.battery = fact({ percent: 80, charging: true, powerState: 'charging' });
    const evalOk = evaluateNeeds({
      snapshot: okSnap,
      modelConnectivity: 'online',
      stuckJobCount: 0,
      previous: { energy: evalMid.needs.energy },
    });
    const r3 = await instinct.reconcile(okSnap, evalOk.needs, false);
    expect(r3.powerChanged).toMatchObject({ from: 'eco', to: 'normal' });
    expect(sense.getSettings().powerMode).toBe('normal');
  });

  it('静默网关探活按指数退避探测：首次失败 degraded、二次失败 offline 并自动进 eco，恢复后回到 online', async () => {
    const sense = createMockSenseService();
    let reachable = false;
    const probe = vi.fn(async () => reachable);
    const instinct = new InstinctController(sense, probe);

    const s1 = makeSnapshot({ now: T0 });
    const e1 = evaluateNeeds({ snapshot: s1, modelConnectivity: 'online', stuckJobCount: 0 });
    await instinct.reconcile(s1, e1.needs, false);
    expect(instinct.modelConnectivity()).toBe('degraded');
    expect(probe).toHaveBeenCalledTimes(1);

    // 未满 10s 退避窗口不重复探活
    const sEarly = makeSnapshot({ now: T0 + 5_000 });
    await instinct.reconcile(sEarly, e1.needs, false);
    expect(probe).toHaveBeenCalledTimes(1);

    // 10s 后第二次失败 → offline + eco
    const s2 = makeSnapshot({ now: T0 + 10_000 });
    const e2 = evaluateNeeds({ snapshot: s2, modelConnectivity: instinct.modelConnectivity(), stuckJobCount: 0 });
    await instinct.reconcile(s2, e2.needs, false);
    expect(instinct.modelConnectivity()).toBe('offline');
    expect(sense.getSettings().powerMode).toBe('eco');

    // 20s 退避后网关恢复 → online + normal
    reachable = true;
    const s3 = makeSnapshot({ now: T0 + 30_000, settings: sense.getSettings() });
    const e3 = evaluateNeeds({ snapshot: s3, modelConnectivity: 'online', stuckJobCount: 0 });
    await instinct.reconcile(s3, e3.needs, false);
    expect(instinct.modelConnectivity()).toBe('online');
    expect(sense.getSettings().powerMode).toBe('normal');
  });

  it('生产受限地址（192.168.0.35 / .34）及本机生产隧道端口绝不发起真实网络连接', async () => {
    const ac = new AbortController();
    expect(await defaultEndpointProbe('http://192.168.0.35:8080', ac.signal)).toBe(true);
    expect(await defaultEndpointProbe('http://192.168.0.34:8080', ac.signal)).toBe(true);
    expect(await defaultEndpointProbe('http://127.0.0.1:19030/v1', ac.signal)).toBe(true);
    expect(await defaultEndpointProbe('http://localhost:13306', ac.signal)).toBe(true);
  });

  it('无活跃会话（model endpoint unknown）且系统断网时绝不误报网关失联；剩余续航 <=15 分钟触发 eco；HEAD 405 回退 GET', async () => {
    const sense = createMockSenseService();
    const instinct = new InstinctController(sense, async () => false);

    // 1. 无活跃会话时 model 为 unknown + Wi-Fi 断开，不应误判云端网关失联
    const wifiOff = makeSnapshot({ now: T0, activeSessionId: undefined });
    wifiOff.state.env.where.model = fact(null, { status: 'unknown' });
    wifiOff.state.self.body.network = fact({ online: false, rxBps: 0, txBps: 0 });
    const evalWifiOff = evaluateNeeds({ snapshot: wifiOff, modelConnectivity: 'online', stuckJobCount: 0 });
    await instinct.reconcile(wifiOff, evalWifiOff.needs, false);
    expect(instinct.modelConnectivity()).toBe('online');

    // 2. 电量 22% 但剩余续航仅 12 分钟（energy critical）时同样立即开启 eco
    const shortLeft = makeSnapshot({ now: T0 + 5_000 });
    shortLeft.state.self.body.battery = fact({ percent: 22, charging: false, powerState: 'battery', minutesLeft: 12 });
    const evalShort = evaluateNeeds({ snapshot: shortLeft, modelConnectivity: 'online', stuckJobCount: 0 });
    expect(evalShort.needs.energy.zone).toBe('critical');
    await instinct.reconcile(shortLeft, evalShort.needs, false);
    expect(sense.getSettings().powerMode).toBe('eco');

    // 3. defaultEndpointProbe 对不支持 HEAD (501) 但支持 GET /v1 的本地网关回退探活成功
    const methods: string[] = [];
    const srv = createServer((req, res) => {
      methods.push(`${req.method}:${req.url}`);
      if (req.method === 'HEAD') {
        res.writeHead(501).end();
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"auth"}');
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const ok = await defaultEndpointProbe(`http://127.0.0.1:${port}/v1`, new AbortController().signal);
      expect(ok).toBe(true);
      expect(methods).toEqual(['HEAD:/v1', 'GET:/v1']);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
