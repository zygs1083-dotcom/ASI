import type { Api, FauxProviderRegistration, Model } from '@mariozechner/pi-ai';
import {
  fauxAssistantMessage,
  fauxText,
  getModel,
  getModels,
  getProviders,
  registerFauxProvider,
} from '@mariozechner/pi-ai';
import type { CatalogProvider, ModelInfo, ProviderConfig } from '../../shared/types';
import { FAUX_PROVIDER_ID } from '../stores/provider-store';

const FAUX_MODEL_ID = 'faux-chat';
const DEFAULT_FAUX_REPLY = '你好，我是测试模型。';
const SLOW_FAUX_REPLY =
  '这是一条用于测试的模拟长回复，用来验证界面在较慢的流式输出下的表现。它会以固定的速度逐段到达，' +
  '帮助你观察光标的闪烁、文本的追加、滚动跟随以及停止按钮的切换是否都符合预期。在真实使用中，模型' +
  '的回答可能很长，也可能因为网络或厂商的原因而变慢，所以界面需要在这些情况下依然保持流畅和可控。' +
  '这段文字本身没有实际含义，只是占位内容，用来填充足够的长度，让测试过程更接近真实的对话场景。比如' +
  '当用户连续发送多条消息、在回复中途点击停止、或者切换到另一个会话再切回来时，较长的增量输出更容' +
  '易暴露状态更新和渲染方面的问题。因此测试场景特意让它缓慢地输出约四百个字符。如果你在测试中看到' +
  '这段文字，说明模拟厂商正在按预期工作，可以放心地继续检查其它交互细节。';

// pi-ai 内置但不出现在目录中的厂商：它们的授权方式不是静态 API Key——
// openai-codex / github-copilot / google-gemini-cli / google-antigravity 走 OAuth 登录，
// google-vertex 走 Google ADC，amazon-bedrock 走 AWS 凭证链
// （产品契约只支持 API Key，尽管新版 pi-ai 允许为其中部分厂商手动提供 token）。
// anthropic 虽然也支持 OAuth，但同时支持静态 API Key，必须保留。
const DENIED_PROVIDERS: ReadonlySet<string> = new Set([
  'openai-codex',
  'github-copilot',
  'google-gemini-cli',
  'google-antigravity',
  'google-vertex',
  'amazon-bedrock',
]);

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  zai: 'Z.ai',
  'azure-openai-responses': 'Azure OpenAI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  huggingface: 'Hugging Face',
  fireworks: 'Fireworks',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax（中国）',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI（中国）',
  'kimi-coding': 'Kimi Coding',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  xiaomi: 'Xiaomi',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan（中国）',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan（阿姆斯特丹）',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan（新加坡）',
};

export function builtinProviderName(id: string): string {
  return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function isSupportedBuiltinProvider(id: string): boolean {
  return !DENIED_PROVIDERS.has(id) && (getProviders() as string[]).includes(id);
}

// getModel/getModels 的泛型签名只接受字面量类型，运行期对未知 id 返回 undefined/[]，
// 这里收窄为动态签名并显式处理空结果
const getModelDynamic = getModel as unknown as (provider: string, modelId: string) => Model<Api> | undefined;
const getModelsDynamic = getModels as unknown as (provider: string) => Model<Api>[];

export class ModelResolver {
  private fauxRegistration: FauxProviderRegistration | undefined;

  constructor() {
    if (process.env.ASI_FAUX === '1') {
      this.fauxRegistration = registerFauxProvider({
        models: [{ id: FAUX_MODEL_ID }],
        tokensPerSecond: 40,
      });
    }
  }

  dispose(): void {
    this.fauxRegistration?.unregister();
    this.fauxRegistration = undefined;
  }

  resolve(provider: ProviderConfig, modelId: string): Model<Api> {
    if (provider.id === FAUX_PROVIDER_ID) {
      return this.resolveFaux(modelId);
    }
    if (provider.kind === 'builtin') {
      const builtin = provider.builtinProvider;
      if (!builtin || !isSupportedBuiltinProvider(builtin)) {
        throw new Error(`不支持的厂商：${builtin ?? provider.name}`);
      }
      const model = getModelDynamic(builtin, modelId);
      if (!model) {
        throw new Error(`厂商 ${provider.name} 中不存在模型 ${modelId}`);
      }
      const resolved = provider.baseUrl ? { ...model, baseUrl: provider.baseUrl } : model;
      return structuredClone(resolved);
    }
    if (!provider.customModels.includes(modelId)) {
      throw new Error(`厂商 ${provider.name} 中不存在模型 ${modelId}`);
    }
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: provider.id,
      baseUrl: provider.baseUrl ?? '',
      reasoning: false,
      input: ['text'],
      compat: { supportsDeveloperRole: false },
      contextWindow: 128000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  listModels(provider: ProviderConfig): ModelInfo[] {
    if (provider.id === FAUX_PROVIDER_ID) {
      if (!this.fauxRegistration) {
        throw new Error('测试厂商未启用（需要 ASI_FAUX=1）');
      }
      return this.fauxRegistration.models.map((m) => this.toModelInfo(provider.id, m));
    }
    if (provider.kind === 'builtin') {
      const builtin = provider.builtinProvider;
      if (!builtin || !isSupportedBuiltinProvider(builtin)) {
        throw new Error(`不支持的厂商：${builtin ?? provider.name}`);
      }
      return getModelsDynamic(builtin).map((m) => this.toModelInfo(provider.id, m));
    }
    return provider.customModels.map((modelId) => ({
      providerId: provider.id,
      modelId,
      name: modelId,
      reasoning: false,
      contextWindow: 128000,
    }));
  }

  catalog(): CatalogProvider[] {
    const catalog: CatalogProvider[] = getProviders()
      .filter((id) => !DENIED_PROVIDERS.has(id))
      .map((id) => ({
        id,
        name: builtinProviderName(id),
        modelCount: getModelsDynamic(id).length,
      }));
    if (this.fauxRegistration) {
      catalog.push({
        id: FAUX_PROVIDER_ID,
        name: 'Faux (测试)',
        modelCount: this.fauxRegistration.models.length,
      });
    }
    return catalog;
  }

  /**
   * 必须在调用 faux 模型的 stream()/complete() 之前同步调用：
   * 响应队列按请求顺序消费，提前入队会被并发会话偷走。
   * text 是用户消息，仅用于识别测试指令：/error 返回错误、/slow 返回慢速长文本；
   * 普通消息一律回复 ASI_FAUX_REPLY（未设置时为默认中文回复），不回显输入。
   * 非 faux 模式下是 no-op。
   */
  prepareFauxResponse(text = ''): void {
    const registration = this.fauxRegistration;
    if (!registration) {
      return;
    }
    if (text.startsWith('/error')) {
      registration.setResponses([
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: '测试模型返回错误' }),
      ]);
    } else if (text.startsWith('/slow')) {
      registration.setResponses([fauxAssistantMessage([fauxText(SLOW_FAUX_REPLY)])]);
    } else {
      const reply = process.env.ASI_FAUX_REPLY ?? DEFAULT_FAUX_REPLY;
      registration.setResponses([fauxAssistantMessage([fauxText(reply)])]);
    }
  }

  private resolveFaux(modelId: string): Model<Api> {
    if (!this.fauxRegistration) {
      throw new Error('测试厂商未启用（需要 ASI_FAUX=1）');
    }
    const model = this.fauxRegistration.getModel(modelId);
    if (!model) {
      throw new Error(`厂商 Faux (测试) 中不存在模型 ${modelId}`);
    }
    return structuredClone(model);
  }

  private toModelInfo(providerId: string, model: Model<Api>): ModelInfo {
    return {
      providerId,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    };
  }
}
