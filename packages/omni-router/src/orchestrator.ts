import { randomUUID } from 'node:crypto';
import type {
  BridgeMemoryItem,
  BridgeSnapshot,
  DelegationProposal,
  PrivacyState,
  SystemOneDecision,
} from '@asi/presence-protocol';
import type { PresenceConfig, PresenceSecrets } from './config.ts';
import { type ChatMessage, sameUrlOrigin, streamLlmChat } from './llm-client.ts';
import { buildXueerSystemPrompt } from './persona.ts';
import { SentenceStreamChunker, sanitizeForSpeech } from './sentence-chunker.ts';
import { evaluateSystemOne } from './system-one.ts';

export interface CompanionBridgeAdapter {
  getSnapshot(): BridgeSnapshot;
  recallMemory(query: string, limit?: number): Promise<BridgeMemoryItem[]>;
}

export interface CompanionTurnInput {
  userText: string;
  history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  privacy: PrivacyState;
  signal?: AbortSignal;
}

export type CompanionTurnEvent =
  | { type: 'decision'; decision: SystemOneDecision }
  | { type: 'memories'; memories: BridgeMemoryItem[] }
  | { type: 'token'; delta: string; accumulated: string }
  | { type: 'sentence'; index: number; text: string; speechText: string }
  | { type: 'delegation_proposal'; proposal: DelegationProposal }
  | {
      type: 'done';
      fullText: string;
      decision: SystemOneDecision;
      recalledMemories: BridgeMemoryItem[];
      delegationProposal?: DelegationProposal;
    };

export interface OrchestratorDeps {
  getConfig: () => Promise<PresenceConfig>;
  getSecrets: () => Promise<PresenceSecrets>;
  bridge: CompanionBridgeAdapter;
  fetchImpl?: typeof fetch;
}

/**
 * Multi-brain companion turn orchestrator:
 * System One (Jev / magpie) -> selective DSH memory recall -> streaming fast-brain LLM ->
 * sentence chunking for real-time TTS & lip-sync -> optional DSH slow-brain delegation proposal.
 */
export class OmniCompanionOrchestrator {
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  async *runTurn(input: CompanionTurnInput): AsyncGenerator<CompanionTurnEvent> {
    const [config, secrets] = await Promise.all([this.deps.getConfig(), this.deps.getSecrets()]);
    const bridgeSnapshot = this.deps.bridge.getSnapshot();

    const decision = await evaluateSystemOne(
      {
        userText: input.userText,
        bridgeSnapshot,
        privacy: input.privacy,
        recentHistory: input.history,
      },
      {
        config: config.systemOne,
        typesafeApiKey: secrets.typesafeApiKey,
        fallbackApiKey: sameUrlOrigin(config.systemOne.fallbackBaseUrl, config.fastBrain.baseUrl)
          ? secrets.fastBrainApiKey
          : undefined,
        fetchImpl: this.deps.fetchImpl,
        signal: input.signal,
      },
    );

    if (input.signal?.aborted) return;
    yield { type: 'decision', decision };

    let recalledMemories: BridgeMemoryItem[] = [];
    if (decision.needMemory && bridgeSnapshot.connected) {
      try {
        recalledMemories = await this.deps.bridge.recallMemory(decision.memoryQuery ?? input.userText, 5);
      } catch {
        recalledMemories = [];
      }
      if (input.signal?.aborted) return;
      if (recalledMemories.length > 0) {
        yield { type: 'memories', memories: recalledMemories };
      }
    }

    const systemPrompt = buildXueerSystemPrompt({
      config,
      bridgeSnapshot,
      decision,
      recalledMemories,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...input.history.slice(-10).map((turn) => ({
        role: turn.role,
        content: turn.text,
      })),
      { role: 'user', content: input.userText },
    ];

    const chunker = new SentenceStreamChunker();
    let fullText = '';
    let sentenceIndex = 0;

    for await (const chunk of streamLlmChat({
      provider: config.fastBrain.provider,
      baseUrl: config.fastBrain.baseUrl,
      model: config.fastBrain.model,
      apiKey: secrets.fastBrainApiKey,
      messages,
      temperature: config.fastBrain.temperature,
      maxTokens: config.fastBrain.maxTokens,
      signal: input.signal,
      fetchImpl: this.deps.fetchImpl,
    })) {
      if (input.signal?.aborted) return;
      if (chunk.delta) {
        fullText += chunk.delta;
        yield { type: 'token', delta: chunk.delta, accumulated: fullText };
        const sentences = chunker.push(chunk.delta);
        for (const text of sentences) {
          const speechText = sanitizeForSpeech(text);
          if (speechText) {
            yield { type: 'sentence', index: sentenceIndex, text, speechText };
            sentenceIndex += 1;
          }
        }
      }
    }

    if (input.signal?.aborted) return;
    for (const tail of chunker.flush()) {
      const speechText = sanitizeForSpeech(tail);
      if (speechText) {
        yield { type: 'sentence', index: sentenceIndex, text: tail, speechText };
        sentenceIndex += 1;
      }
    }

    let delegationProposal: DelegationProposal | undefined;
    if (decision.needDshDelegation || decision.route === 'delegate_dsh') {
      delegationProposal = {
        id: `del_${randomUUID().slice(0, 8)}`,
        summary: `委派给 DSH 慢脑处理：${input.userText.slice(0, 60)}`,
        suggestedPrompt: input.userText,
        status: 'pending_confirmation',
        createdAt: Date.now(),
      };
      yield { type: 'delegation_proposal', proposal: delegationProposal };
    }

    yield {
      type: 'done',
      fullText,
      decision,
      recalledMemories,
      ...(delegationProposal ? { delegationProposal } : {}),
    };
  }
}
