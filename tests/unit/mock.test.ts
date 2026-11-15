import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../src/renderer/dev/mockApi';
import type { AsiApi, ChatEvent, Conversation } from '../../src/shared/types';

let api: AsiApi;

beforeEach(() => {
  vi.useFakeTimers();
  api = createMockApi();
});

afterEach(() => {
  vi.useRealTimers();
});

async function firstConversationWithModel(): Promise<Conversation> {
  const list = await api.conversations.list();
  for (const s of list) {
    const c = await api.conversations.get(s.id);
    if (c?.model) return c;
  }
  throw new Error('seed data missing a modeled conversation');
}

function collectEvents(): { events: ChatEvent[]; off: () => void } {
  const events: ChatEvent[] = [];
  const off = api.chat.onEvent((e) => events.push(e));
  return { events, off };
}

describe('mock providers', () => {
  it('seeds two providers and never exposes a plaintext key', async () => {
    const providers = await api.providers.list();
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.kind).sort()).toEqual(['builtin', 'openai-compatible']);
    expect(JSON.stringify(providers)).not.toContain('sk-');
  });

  it('save stores only the hasApiKey flag (undefined keep / null clear / string set)', async () => {
    const created = await api.providers.save({
      name: 'Key Co',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:9/v1',
      apiKey: 'sk-secret-123',
      enabled: true,
      customModels: ['m1'],
    });
    expect(created.hasApiKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain('sk-secret-123');
    expect(JSON.stringify(await api.providers.list())).not.toContain('sk-secret-123');

    const kept = await api.providers.save({ ...created, customModels: ['m1', 'm2'] });
    expect(kept.hasApiKey).toBe(true);

    const cleared = await api.providers.save({ ...created, apiKey: null });
    expect(cleared.hasApiKey).toBe(false);
  });

  it('lists catalog, per-provider models and all enabled models', async () => {
    const catalog = await api.providers.catalog();
    expect(catalog.length).toBeGreaterThan(0);
    const providers = await api.providers.list();
    for (const p of providers) {
      const models = await api.providers.models(p.id);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) expect(m.providerId).toBe(p.id);
    }
    const all = await api.providers.allModels();
    expect(all.length).toBe(
      (await api.providers.models(providers[0].id)).length +
        (await api.providers.models(providers[1].id)).length,
    );
  });

  it('a newly saved builtin provider exposes catalog models under its instance id', async () => {
    const created = await api.providers.save({
      name: 'OpenAI',
      kind: 'builtin',
      builtinProvider: 'openai',
      enabled: true,
      customModels: [],
    });
    const models = await api.providers.models(created.id);
    const catalog = await api.providers.catalog();
    expect(models.length).toBe(catalog.find((c) => c.id === 'openai')?.modelCount);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(m.providerId).toBe(created.id);
  });

  it('switching a provider kind recomputes its models', async () => {
    const created = await api.providers.save({
      name: 'Switch',
      kind: 'builtin',
      builtinProvider: 'openai',
      enabled: true,
      customModels: [],
    });

    await api.providers.save({
      id: created.id,
      name: 'Switch',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:9/v1',
      enabled: true,
      customModels: ['custom-a', 'custom-b'],
    });
    let models = await api.providers.models(created.id);
    expect(models.map((m) => m.modelId).sort()).toEqual(['custom-a', 'custom-b']);
    expect(models.every((m) => m.providerId === created.id)).toBe(true);

    await api.providers.save({
      id: created.id,
      name: 'Switch',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      enabled: true,
      customModels: [],
    });
    models = await api.providers.models(created.id);
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.modelId)).toContain('claude-sonnet-4-5');
    expect(models.every((m) => m.providerId === created.id)).toBe(true);
  });
});

describe('mock conversations', () => {
  it('returns snapshots: mutating results does not corrupt state', async () => {
    const conv = await firstConversationWithModel();
    conv.title = 'mutated';
    conv.messages.push({ id: 'x', role: 'user', text: 'x', createdAt: 0 });
    const fresh = await api.conversations.get(conv.id);
    expect(fresh?.title).not.toBe('mutated');
    expect(fresh?.messages.find((m) => m.id === 'x')).toBeUndefined();
  });

  it('creates, sorts by updatedAt desc, renames and removes', async () => {
    const created = await api.conversations.create();
    let list = await api.conversations.list();
    expect(list[0].id).toBe(created.id);

    const older = await api.conversations.create();
    await api.conversations.rename(older.id, '改名');
    list = await api.conversations.list();
    expect(list.find((s) => s.id === older.id)?.title).toBe('改名');
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].updatedAt).toBeGreaterThanOrEqual(list[i].updatedAt);
    }

    await api.conversations.remove(created.id);
    expect(await api.conversations.get(created.id)).toBeNull();
  });

  it('setModel updates the conversation model', async () => {
    const conv = await api.conversations.create();
    const model = { providerId: 'p-anthropic', modelId: 'claude-haiku-4-5' };
    await api.conversations.setModel(conv.id, model);
    expect((await api.conversations.get(conv.id))?.model).toEqual(model);
  });
});

describe('mock chat streaming', () => {
  it('send resolves user+streaming assistant immediately, then streams deltas to done', async () => {
    const conv = await firstConversationWithModel();
    const { events, off } = collectEvents();
    const { user, assistant } = await api.chat.send(conv.id, '你好');

    expect(user.status).toBe('done');
    expect(user.text).toBe('你好');
    expect(assistant.status).toBe('streaming');
    expect(events).toHaveLength(0);

    const inStore = await api.conversations.get(conv.id);
    const stored = inStore?.messages.find((m) => m.id === assistant.id);
    expect(stored?.status).toBe('streaming');

    await vi.advanceTimersByTimeAsync(60_000);
    off();

    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(3);
    for (const d of deltas) {
      if (d.type !== 'delta') continue;
      expect([...d.delta]).toHaveLength(1);
      expect(d.conversationId).toBe(conv.id);
      expect(d.messageId).toBe(assistant.id);
    }
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type !== 'done') throw new Error('unreachable');
    expect(done.message.status).toBe('done');
    expect(done.message.text).toBe(deltas.map((d) => (d.type === 'delta' ? d.delta : '')).join(''));

    const final = await api.conversations.get(conv.id);
    expect(final?.messages.find((m) => m.id === assistant.id)?.status).toBe('done');
  });

  it('rejects a concurrent send on the same conversation', async () => {
    const conv = await firstConversationWithModel();
    await api.chat.send(conv.id, '一');
    await expect(api.chat.send(conv.id, '二')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('rejects send on a conversation without a model', async () => {
    const list = await api.conversations.list();
    let target: string | null = null;
    for (const s of list) {
      const c = await api.conversations.get(s.id);
      if (c && !c.model) target = c.id;
    }
    expect(target).not.toBeNull();
    if (!target) return;
    await expect(api.chat.send(target, 'hi')).rejects.toThrow(/模型/);
  });

  it('abort preserves partial text, marks aborted and stops future deltas', async () => {
    const conv = await firstConversationWithModel();
    const { events, off } = collectEvents();
    const { assistant } = await api.chat.send(conv.id, 'hi');

    await vi.advanceTimersByTimeAsync(80);
    const partialCount = events.filter((e) => e.type === 'delta').length;
    expect(partialCount).toBeGreaterThan(0);

    await api.chat.abort(conv.id);
    const partial = (await api.conversations.get(conv.id))?.messages.find((m) => m.id === assistant.id);
    expect(partial?.status).toBe('aborted');
    expect(partial?.text.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'error' && e.message.id === assistant.id)).toBe(true);

    const countAtAbort = events.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.length).toBe(countAtAbort);
    off();
  });

  it('removing a conversation cancels its stream silently', async () => {
    const conv = await firstConversationWithModel();
    const { events, off } = collectEvents();
    await api.chat.send(conv.id, 'hi');
    await api.conversations.remove(conv.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.filter((e) => e.conversationId === conv.id)).toHaveLength(0);
    off();
  });

  it('unsubscribed listeners stop receiving events', async () => {
    const conv = await firstConversationWithModel();
    const { events, off } = collectEvents();
    off();
    await api.chat.send(conv.id, 'hi');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(0);
  });
});

describe('mock settings', () => {
  it('gets and patches settings', async () => {
    const settings = await api.settings.get();
    expect(settings.theme).toBe('system');
    const updated = await api.settings.set({ theme: 'dark' });
    expect(updated.theme).toBe('dark');
    expect((await api.settings.get()).theme).toBe('dark');
  });

  it('set snapshots the patch so mutating the input does not corrupt state', async () => {
    const patch = { defaultModel: { providerId: 'p-demo', modelId: 'demo-7b' } };
    const updated = await api.settings.set(patch);
    patch.defaultModel.modelId = 'mutated';
    expect(updated.defaultModel?.modelId).toBe('demo-7b');
    expect((await api.settings.get()).defaultModel?.modelId).toBe('demo-7b');
  });
});
