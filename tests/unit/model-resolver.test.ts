import type { Context } from '@mariozechner/pi-ai';
import { complete } from '@mariozechner/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  builtinProviderName,
  isSupportedBuiltinProvider,
  ModelResolver,
} from '../../src/main/chat/model-resolver';
import { FAUX_PROVIDER_ID } from '../../src/main/stores/provider-store';
import type { ProviderConfig } from '../../src/shared/types';

function builtinCfg(builtinProvider: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'cfg-1',
    name: builtinProvider,
    kind: 'builtin',
    builtinProvider,
    hasApiKey: true,
    enabled: true,
    customModels: [],
    createdAt: 0,
    ...overrides,
  };
}

function compatCfg(customModels: string[], overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'compat-1',
    name: 'Local',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    hasApiKey: false,
    enabled: true,
    customModels,
    createdAt: 0,
    ...overrides,
  };
}

const fauxCfg = builtinCfg('faux', { id: FAUX_PROVIDER_ID, name: 'Faux (测试)' });

const resolvers: ModelResolver[] = [];

function resolver(): ModelResolver {
  const r = new ModelResolver();
  resolvers.push(r);
  return r;
}

function ctx(): Context {
  return { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] };
}

afterEach(() => {
  for (const r of resolvers.splice(0)) {
    r.dispose();
  }
  vi.unstubAllEnvs();
});

describe('isSupportedBuiltinProvider', () => {
  it('keeps API-key providers and rejects OAuth/ADC/AWS-only and unknown ids', () => {
    for (const ok of ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'groq', 'openrouter', 'mistral']) {
      expect(isSupportedBuiltinProvider(ok), ok).toBe(true);
    }
    for (const denied of [
      'openai-codex',
      'github-copilot',
      'google-vertex',
      'amazon-bedrock',
      'google-gemini-cli',
      'google-antigravity',
      'bogus-provider',
      'faux',
    ]) {
      expect(isSupportedBuiltinProvider(denied), denied).toBe(false);
    }
  });
});

describe('ModelResolver.catalog', () => {
  it('excludes denied providers and includes anthropic with friendly names', () => {
    const catalog = resolver().catalog();
    const ids = catalog.map((c) => c.id);
    for (const denied of ['openai-codex', 'github-copilot', 'google-vertex', 'amazon-bedrock']) {
      expect(ids).not.toContain(denied);
    }
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    const openai = catalog.find((c) => c.id === 'openai');
    const google = catalog.find((c) => c.id === 'google');
    expect(openai?.name).toBe('OpenAI');
    expect(google?.name).toBe('Google Gemini');
    expect(openai?.modelCount).toBeGreaterThan(0);
  });

  it('falls back to capitalizing unknown provider ids', () => {
    expect(builtinProviderName('anthropic')).toBe('Anthropic');
    expect(builtinProviderName('something-new')).toBe('Something-new');
  });
});

describe('ModelResolver.resolve builtin', () => {
  it('resolves a builtin model snapshot', () => {
    const model = resolver().resolve(builtinCfg('anthropic'), 'claude-sonnet-4-5');
    expect(model.provider).toBe('anthropic');
    expect(model.id).toBe('claude-sonnet-4-5');
    expect(typeof model.api).toBe('string');
    expect(model.baseUrl).toBeTruthy();
  });

  it('applies a baseUrl override only when present', () => {
    const r = resolver();
    const overridden = r.resolve(
      builtinCfg('anthropic', { baseUrl: 'https://proxy.example.com' }),
      'claude-sonnet-4-5',
    );
    expect(overridden.baseUrl).toBe('https://proxy.example.com');
    const plain = r.resolve(builtinCfg('anthropic'), 'claude-sonnet-4-5');
    expect(plain.baseUrl).not.toBe('https://proxy.example.com');
  });

  it('throws a readable Chinese error for an unknown model', () => {
    expect(() => resolver().resolve(builtinCfg('anthropic'), 'no-such-model')).toThrow(/不存在/);
  });

  it('rejects denied providers even though pi-ai knows them', () => {
    for (const denied of ['openai-codex', 'github-copilot', 'google-vertex', 'amazon-bedrock']) {
      expect(() => resolver().resolve(builtinCfg(denied), 'any'), denied).toThrow(/不支持/);
      expect(() => resolver().listModels(builtinCfg(denied)), denied).toThrow(/不支持/);
    }
  });

  it('rejects an unknown builtin provider id', () => {
    expect(() => resolver().resolve(builtinCfg('bogus'), 'x')).toThrow(/不支持/);
  });

  it('returns independent snapshots that cannot mutate the registry', () => {
    const r = resolver();
    const a = r.resolve(builtinCfg('deepseek'), 'deepseek-v4-flash');
    a.baseUrl = 'https://mutated.example.com';
    a.cost.input = 999;
    const b = r.resolve(builtinCfg('deepseek'), 'deepseek-v4-flash');
    expect(b.baseUrl).not.toBe('https://mutated.example.com');
    expect(b.cost.input).not.toBe(999);
  });
});

describe('ModelResolver.resolve openai-compatible', () => {
  it('constructs the contract model shape for a listed custom model', () => {
    const model = resolver().resolve(compatCfg(['llama3.1']), 'llama3.1');
    expect(model).toEqual({
      id: 'llama3.1',
      name: 'llama3.1',
      api: 'openai-completions',
      provider: 'compat-1',
      baseUrl: 'http://localhost:11434/v1',
      reasoning: false,
      input: ['text'],
      compat: { supportsDeveloperRole: false },
      contextWindow: 128000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('rejects models not in customModels', () => {
    expect(() => resolver().resolve(compatCfg(['a']), 'b')).toThrow(/不存在/);
  });
});

describe('ModelResolver.listModels', () => {
  it('maps builtin models to ModelInfo with the instance providerId', () => {
    const models = resolver().listModels(builtinCfg('google'));
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.providerId).toBe('cfg-1');
      expect(m.modelId).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(typeof m.reasoning).toBe('boolean');
    }
  });

  it('maps compatible customModels to ModelInfo', () => {
    const models = resolver().listModels(compatCfg(['a', 'b']));
    expect(models).toEqual([
      { providerId: 'compat-1', modelId: 'a', name: 'a', reasoning: false, contextWindow: 128000 },
      { providerId: 'compat-1', modelId: 'b', name: 'b', reasoning: false, contextWindow: 128000 },
    ]);
  });
});

describe('ModelResolver faux provider', () => {
  it('registers only under ASI_FAUX=1 and resolves the faux model', () => {
    vi.stubEnv('ASI_FAUX', '1');
    const r = resolver();
    const model = r.resolve(fauxCfg, 'faux-chat');
    expect(model.provider).toBe('faux');
    expect(model.id).toBe('faux-chat');
    expect(r.catalog().map((c) => c.id)).toContain(FAUX_PROVIDER_ID);
    expect(r.listModels(fauxCfg).map((m) => m.modelId)).toEqual(['faux-chat']);
    expect(() => r.resolve(fauxCfg, 'other')).toThrow(/不存在/);
  });

  it('prepareFauxResponse replies with the default Chinese reply, never echoing the prompt', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    vi.stubEnv('ASI_FAUX_REPLY', undefined);
    const r = resolver();
    const model = r.resolve(fauxCfg, 'faux-chat');
    r.prepareFauxResponse('hello');
    const reply = await complete(model, ctx());
    expect(reply.stopReason).toBe('stop');
    const text = reply.content.find((b) => b.type === 'text');
    const body = text && 'text' in text ? text.text : '';
    expect(body).toBe('你好，我是测试模型。');
    expect(body).not.toBe('hello');
  });

  it('prepareFauxResponse honours ASI_FAUX_REPLY for ordinary prompts', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    vi.stubEnv('ASI_FAUX_REPLY', '自定义回复');
    const r = resolver();
    r.prepareFauxResponse('hello');
    const reply = await complete(r.resolve(fauxCfg, 'faux-chat'), ctx());
    const text = reply.content.find((b) => b.type === 'text');
    expect(text && 'text' in text ? text.text : '').toBe('自定义回复');
  });

  it('prepareFauxResponse /error queues an error assistant message', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const r = resolver();
    r.prepareFauxResponse('/error');
    const reply = await complete(r.resolve(fauxCfg, 'faux-chat'), ctx());
    expect(reply.stopReason).toBe('error');
    expect(reply.errorMessage).toBe('测试模型返回错误');
  });

  it('prepareFauxResponse /slow queues a ~400 character reply', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const r = resolver();
    r.prepareFauxResponse('/slow');
    const reply = await complete(r.resolve(fauxCfg, 'faux-chat'), ctx());
    const text = reply.content.find((b) => b.type === 'text');
    const body = text && 'text' in text ? text.text : '';
    expect(Array.from(body).length).toBeGreaterThanOrEqual(300);
  }, 15000);

  it('without ASI_FAUX, faux calls reject and prepareFauxResponse is a no-op', () => {
    vi.stubEnv('ASI_FAUX', '');
    const r = resolver();
    expect(() => r.resolve(fauxCfg, 'faux-chat')).toThrow();
    expect(() => r.listModels(fauxCfg)).toThrow();
    expect(() => r.prepareFauxResponse()).not.toThrow();
    expect(r.catalog().map((c) => c.id)).not.toContain(FAUX_PROVIDER_ID);
  });
});
