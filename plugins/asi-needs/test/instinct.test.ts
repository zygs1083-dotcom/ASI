import { describe, expect, it, vi } from 'vitest';
import { evaluateNeeds } from '../src/host/evaluator.js';
import { defaultEndpointProbe, InstinctController } from '../src/host/instinct.js';
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

  it('生产受限地址（192.168.0.35 / .34）绝不发起真实网络连接', async () => {
    const ac = new AbortController();
    expect(await defaultEndpointProbe('http://192.168.0.35:8080', ac.signal)).toBe(true);
    expect(await defaultEndpointProbe('http://192.168.0.34:8080', ac.signal)).toBe(true);
  });
});
