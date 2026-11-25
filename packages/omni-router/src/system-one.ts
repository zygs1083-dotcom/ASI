import {
  type BridgeSnapshot,
  type JevNormalizedBox,
  type JevQuestion,
  JevResponseSchema,
  type PresenceEmotion,
  PresenceEmotionSchema,
  type PrivacyState,
  type SystemOneDecision,
  type SystemOneRoute,
  SystemOneRouteSchema,
} from '@asi/presence-protocol';
import { z } from 'zod';
import type { PresenceConfig } from './config.ts';

export interface SystemOneInput {
  userText: string;
  bridgeSnapshot: BridgeSnapshot;
  privacy: PrivacyState;
  recentHistory?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  /** Optional in-memory base64 data URL (M2 screen vision; never read from disk). */
  imageDataUrl?: string;
  /** Optional target description for Jev `box` localization. */
  boxInstruction?: string;
}

export interface SystemOneEvalOptions {
  config: PresenceConfig['systemOne'];
  typesafeApiKey?: string;
  fallbackApiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const ROUTE_CRITERIA: Record<SystemOneRoute, string> = {
  fast_reply: 'Direct warm conversation, Q&A, companionship, emotional support, or quick explanation.',
  recall_memory:
    'User asks about past preferences, previous decisions, prior bugs/pitfalls, history, or something discussed earlier.',
  inspect_screen:
    'User explicitly asks to look at the screen, UI, error window, chart, image, or what is currently visible on desktop.',
  delegate_dsh:
    'User asks to execute real engineering work on repositories: edit files, fix code bugs, run tests, inspect git repos, or deploy via DSH.',
};

const EMOTION_CRITERIA: Record<PresenceEmotion, string> = {
  calm: 'Peaceful, relaxed, steady interaction.',
  focused: 'Technical, analytical, concentrated work or debugging.',
  joyful: 'Cheerful, celebratory, playful, positive news, or excitement.',
  alert: 'Warning, urgent error, crash, low battery/thermal stress, or caution needed.',
  tired: 'Late night, fatigue, low energy, resting, or system eco/low-power mode.',
  thinking: 'Deep reasoning, multi-step planning, architecture, or complex recall.',
  affectionate: 'Warm greeting, personal bonding, thanking, calling the companion warmly (like 雪儿).',
};

const ENERGY_RUBRIC = ['very_calm', 'gentle', 'balanced', 'lively', 'energetic'] as const;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function buildCompactState(input: SystemOneInput): Record<string, unknown> {
  const { bridgeSnapshot, privacy } = input;
  const recent = (input.recentHistory ?? []).slice(-4).map((m) => ({
    role: m.role,
    text: m.text.slice(0, 180),
  }));
  return {
    user_message: input.userText.slice(0, 1200),
    recent_turns: recent,
    dsh_connected: bridgeSnapshot.connected,
    partner_tom_state: bridgeSnapshot.tom.state,
    partner_should_defer: bridgeSnapshot.tom.shouldDefer,
    homeostasis_zone: bridgeSnapshot.needs.overallZone,
    homeostasis_satisfaction: bridgeSnapshot.needs.overallSatisfaction,
    battery_percent: bridgeSnapshot.vitals.batteryPercent,
    power_mode: bridgeSnapshot.vitals.powerMode,
    total_memories: bridgeSnapshot.sleep.totalMemories,
    screen_vision_enabled: privacy.screenVisionEnabled && !privacy.physicalKillSwitch,
    ...(input.imageDataUrl ? { image: input.imageDataUrl } : {}),
  };
}

function normalizeBoxAnswer(answer: {
  box?: JevNormalizedBox;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}): JevNormalizedBox | undefined {
  if (answer.box) return answer.box;
  if (
    typeof answer.top === 'number' &&
    typeof answer.bottom === 'number' &&
    typeof answer.left === 'number' &&
    typeof answer.right === 'number'
  ) {
    return {
      top: clamp(answer.top, 0, 1),
      bottom: clamp(answer.bottom, 0, 1),
      left: clamp(answer.left, 0, 1),
      right: clamp(answer.right, 0, 1),
    };
  }
  return undefined;
}

function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('System One request timed out')), timeoutMs);
  const onExternalAbort = () => controller.abort(external?.reason ?? new Error('Aborted'));
  if (external) {
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function applyPrivacyAndVitalsGuardrails(decision: SystemOneDecision, input: SystemOneInput): SystemOneDecision {
  const canSeeScreen = input.privacy.screenVisionEnabled && !input.privacy.physicalKillSwitch;
  let route = decision.route;
  let needScreen = decision.needScreen;
  let reason = decision.reason;

  if (!canSeeScreen && (route === 'inspect_screen' || needScreen)) {
    needScreen = false;
    if (route === 'inspect_screen') {
      route = 'fast_reply';
      reason = input.privacy.physicalKillSwitch
        ? '物理断眼静音开关已开启，已拒绝看屏并转为快脑提示'
        : '屏幕视觉默认关闭，已转为快脑温和提示开启视觉开关';
    }
  }

  let energy = decision.energy;
  let initiative = decision.initiative;
  if (input.bridgeSnapshot.tom.shouldDefer) {
    energy = Math.min(energy, 48);
    initiative = Math.min(initiative, 0.25);
  }
  if (input.bridgeSnapshot.vitals.powerMode === 'eco') {
    energy = Math.min(energy, 45);
  }

  return {
    ...decision,
    route,
    needScreen,
    energy: Math.round(clamp(energy, 0, 100)),
    initiative: Number(clamp(initiative, 0, 1).toFixed(2)),
    ...(reason ? { reason } : {}),
  };
}

export async function callTypesafeJev(
  input: SystemOneInput,
  options: SystemOneEvalOptions & { typesafeApiKey: string },
): Promise<SystemOneDecision> {
  const startedAt = performance.now();
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.config.typesafeBaseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1/systemone`;

  const questions: Record<string, JevQuestion> = {
    route: {
      type: 'choice',
      instructions: 'Pick the single best cognitive route for the companion to handle the user message.',
      criteria: ROUTE_CRITERIA,
    },
    emotion: {
      type: 'choice',
      instructions: 'Pick the most appropriate emotional tone for the companion 雪儿 in response to the user.',
      criteria: EMOTION_CRITERIA,
    },
    energy: {
      type: 'score',
      instructions: 'Rate the ideal vocal/visual energy level from very_calm (0) to energetic (4).',
      criteria: [...ENERGY_RUBRIC],
    },
    need_memory: {
      type: 'noul',
      instructions: 'Would querying long-term user memory improve this reply?',
    },
    need_screen: {
      type: 'noul',
      instructions: 'Does the user want the companion to inspect their screen right now?',
    },
    need_dsh_delegation: {
      type: 'noul',
      instructions: 'Does this request require delegating a real coding/system execution job to DSH?',
    },
    initiative: {
      type: 'noul',
      instructions: 'Should the companion proactively elaborate or offer a gentle next-step suggestion?',
    },
  };

  if (input.imageDataUrl && input.boxInstruction) {
    questions.focus_box = {
      type: 'box',
      instructions: input.boxInstruction,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.typesafeApiKey}`,
  };
  if (input.imageDataUrl) {
    headers['TypeSafe-Danger-Zone-Images'] = 'true';
  }

  const { signal, cleanup } = combineSignals(options.config.timeoutMs, options.signal);
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.config.jevModel,
        state: buildCompactState(input),
        questions,
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`TypeSafe Jev HTTP ${response.status}`);
    }
    const raw = (await response.json()) as unknown;
    const parsed = JevResponseSchema.parse(raw);

    const routeAns = parsed.answers.route;
    const emotionAns = parsed.answers.emotion;
    const energyAns = parsed.answers.energy;
    const memAns = parsed.answers.need_memory;
    const screenAns = parsed.answers.need_screen;
    const dshAns = parsed.answers.need_dsh_delegation;
    const initAns = parsed.answers.initiative;
    const boxAns = parsed.answers.focus_box;

    const routeParsed =
      routeAns?.type === 'choice' ? SystemOneRouteSchema.safeParse(routeAns.choice) : { success: false as const };
    const emotionParsed =
      emotionAns?.type === 'choice' ? PresenceEmotionSchema.safeParse(emotionAns.choice) : { success: false as const };

    const route: SystemOneRoute = routeParsed.success ? routeParsed.data : 'fast_reply';
    const routeConfidence =
      routeAns?.type === 'choice' ? (routeAns.confidence ?? routeAns.probabilities?.[route] ?? 0.78) : 0.65;
    const emotion: PresenceEmotion = emotionParsed.success ? emotionParsed.data : 'calm';

    // Jev score spans 0..(criteria.length - 1) => normalize into 0..100
    const rawScore = energyAns?.type === 'score' ? energyAns.score : 2;
    const normalizedEnergy =
      rawScore > ENERGY_RUBRIC.length - 1
        ? clamp(rawScore, 0, 100)
        : clamp((rawScore / (ENERGY_RUBRIC.length - 1)) * 100, 10, 100);

    const needMemory = (memAns?.type === 'noul' ? memAns.noul : 0) >= 0.55 || route === 'recall_memory';
    const needScreen = (screenAns?.type === 'noul' ? screenAns.noul : 0) >= 0.58 || route === 'inspect_screen';
    const needDshDelegation = (dshAns?.type === 'noul' ? dshAns.noul : 0) >= 0.62 || route === 'delegate_dsh';
    const initiative = initAns?.type === 'noul' ? initAns.noul : 0.45;
    const focusBox = boxAns?.type === 'box' ? normalizeBoxAnswer(boxAns) : undefined;

    return applyPrivacyAndVitalsGuardrails(
      {
        route,
        routeConfidence: Number(clamp(routeConfidence, 0, 1).toFixed(2)),
        emotion,
        energy: Math.round(normalizedEnergy),
        initiative,
        needMemory,
        needScreen,
        needDshDelegation,
        ...(needMemory ? { memoryQuery: input.userText.slice(0, 160) } : {}),
        ...(focusBox ? { focusBox } : {}),
        backend: 'typesafe-jev',
        latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      },
      input,
    );
  } finally {
    cleanup();
  }
}

const MagpieCalibrationResponseSchema = z.object({
  route: SystemOneRouteSchema.default('fast_reply'),
  routeConfidence: z.number().min(0).max(1).default(0.75),
  emotion: PresenceEmotionSchema.default('calm'),
  energy: z.number().min(0).max(100).default(58),
  initiative: z.number().min(0).max(1).default(0.45),
  needMemory: z.boolean().default(false),
  needScreen: z.boolean().default(false),
  needDshDelegation: z.boolean().default(false),
  memoryQuery: z.string().optional(),
  reason: z.string().optional(),
});

function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

export async function callMagpieCalibrationFallback(
  input: SystemOneInput,
  options: SystemOneEvalOptions,
): Promise<SystemOneDecision> {
  const startedAt = performance.now();
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.config.fallbackBaseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.fallbackApiKey) {
    headers.Authorization = `Bearer ${options.fallbackApiKey}`;
  }

  const prompt = [
    'You are System One fast cognitive router for companion AI 雪儿.',
    'Classify the user turn into strict JSON with keys:',
    'route ("fast_reply"|"recall_memory"|"inspect_screen"|"delegate_dsh"),',
    'routeConfidence (0..1),',
    'emotion ("calm"|"focused"|"joyful"|"alert"|"tired"|"thinking"|"affectionate"),',
    'energy (0..100), initiative (0..1), needMemory (bool), needScreen (bool), needDshDelegation (bool),',
    'memoryQuery (optional concise string), reason (optional concise Chinese phrase <=24 chars).',
    'Output ONLY valid JSON with no prose.',
  ].join(' ');

  const { signal, cleanup } = combineSignals(options.config.timeoutMs, options.signal);
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.config.fallbackModel,
        temperature: 0,
        max_tokens: 220,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(buildCompactState(input)) },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Magpie calibration HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    const jsonBlock = extractFirstJsonObject(content);
    if (!jsonBlock) {
      throw new Error('Magpie calibration did not return JSON');
    }
    const calibrated = MagpieCalibrationResponseSchema.parse(JSON.parse(jsonBlock));
    return applyPrivacyAndVitalsGuardrails(
      {
        ...calibrated,
        backend: 'magpie-fallback',
        latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      },
      input,
    );
  } finally {
    cleanup();
  }
}

export function heuristicEvaluateSystemOne(input: SystemOneInput): SystemOneDecision {
  const startedAt = performance.now();
  const text = input.userText.trim();
  const lower = text.toLowerCase();

  const wantsScreen =
    /(看下屏幕|看一眼屏幕|屏幕|截图|画面|报错界面|看看这个页面|what'?s on my screen|look at my screen|screenshot)/i.test(
      text,
    );
  const wantsDsh =
    /(帮我改代码|修一下|修个?\s*bug|跑单测|运行测试|写个函数|重构|提交代码|部署|拉分支|fix the bug|run tests|refactor|implement in repo)/i.test(
      text,
    );
  const wantsMemory =
    /(记得|上次|之前|回忆|偏好|习惯|踩过什么坑|历史|以前说过|remember|last time|previously|earlier|my preference)/i.test(
      text,
    );
  const warmGreeting = /(雪儿|你好|早安|晚安|回来啦|辛苦了|抱抱|乖|小狗|想你|谢谢|hello|hi|good morning|thanks)/i.test(
    text,
  );
  const alertSignal = /(崩溃|崩了|报错|失败|异常|紧急|卡死|oom|crash|fatal|urgent|error)/i.test(lower);
  const tiredSignal = /(好累|困了|休息|熬夜|睡了|疲惫|tired|sleepy|exhausted)/i.test(lower);
  const joyfulSignal = /(太好了|成功了|搞定|开心|哈哈|太棒|awesome|yay|worked|fixed)/i.test(lower);

  let route: SystemOneRoute = 'fast_reply';
  let routeConfidence = 0.72;
  let reason = '快脑自然陪伴响应';

  if (wantsScreen) {
    route = 'inspect_screen';
    routeConfidence = 0.84;
    reason = '命中看屏意图';
  } else if (wantsDsh) {
    route = 'delegate_dsh';
    routeConfidence = 0.82;
    reason = '命中工程执行/DSH 委派意图';
  } else if (wantsMemory) {
    route = 'recall_memory';
    routeConfidence = 0.8;
    reason = '命中长期记忆召回意图';
  }

  let emotion: PresenceEmotion = 'calm';
  let energy = 58;
  let initiative = 0.45;

  if (alertSignal || input.bridgeSnapshot.needs.overallZone === 'critical') {
    emotion = 'alert';
    energy = 74;
    initiative = 0.6;
  } else if (tiredSignal || input.bridgeSnapshot.vitals.powerMode === 'eco') {
    emotion = 'tired';
    energy = 34;
    initiative = 0.25;
  } else if (joyfulSignal) {
    emotion = 'joyful';
    energy = 82;
    initiative = 0.68;
  } else if (warmGreeting) {
    emotion = 'affectionate';
    energy = 72;
    initiative = 0.58;
  } else if (wantsDsh || wantsMemory) {
    emotion = 'thinking';
    energy = 64;
    initiative = 0.5;
  } else if (input.bridgeSnapshot.tom.state === 'deep_focus' || input.bridgeSnapshot.tom.state === 'stuck_debugging') {
    emotion = 'focused';
    energy = 44;
    initiative = 0.2;
  }

  return applyPrivacyAndVitalsGuardrails(
    {
      route,
      routeConfidence,
      emotion,
      energy,
      initiative,
      needMemory: wantsMemory,
      needScreen: wantsScreen,
      needDshDelegation: wantsDsh,
      ...(wantsMemory ? { memoryQuery: text.slice(0, 160) } : {}),
      backend: 'heuristic-fallback',
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      reason,
    },
    input,
  );
}

/**
 * Multi-tier System One evaluator:
 * 1. Native TypeSafe AI Jev (`POST /v1/systemone`) when `TYPESAFE_API_KEY` is configured.
 * 2. Automatic local `magpie:3425` structured calibration fallback when key missing or Jev unreachable.
 * 3. Deterministic zero-latency heuristic fallback when completely offline.
 */
export async function evaluateSystemOne(
  input: SystemOneInput,
  options: SystemOneEvalOptions,
): Promise<SystemOneDecision> {
  if (!options.config.enabled) {
    return heuristicEvaluateSystemOne(input);
  }

  if (options.config.preferTypesafeJev && options.typesafeApiKey?.trim()) {
    try {
      return await callTypesafeJev(input, {
        ...options,
        typesafeApiKey: options.typesafeApiKey.trim(),
      });
    } catch {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Aborted');
      }
      // Seamlessly degrade to magpie calibration or deterministic heuristics
    }
  }

  if (options.config.fallbackToMagpie) {
    try {
      return await callMagpieCalibrationFallback(input, options);
    } catch {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Aborted');
      }
    }
  }

  return heuristicEvaluateSystemOne(input);
}
