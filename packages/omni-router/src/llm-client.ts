import type { JevNormalizedBox } from '@asi/presence-protocol';
import type { LlmProviderKind } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatParams {
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface LlmStreamChunk {
  delta: string;
  done: boolean;
}

export interface ModelCatalogEntry {
  id: string;
  ownedBy?: string;
}

export interface VisionChatParams {
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  systemPrompt: string;
  userPrompt: string;
  /** In-memory data URL (`data:image/jpeg;base64,...`), never persisted to disk. */
  imageDataUrl: string;
  focusBox?: JevNormalizedBox;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function sameUrlOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

function stripGeminiModelPrefix(model: string): string {
  return model.replace(/^models\//, '');
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (match?.[1] && match[2]) {
    return { mimeType: match[1], base64: match[2] };
  }
  return { mimeType: 'image/png', base64: dataUrl.trim() };
}

/**
 * Normalizes non-system turns for strict alternating-role APIs (Anthropic & Gemini):
 * skips empty turns, strips leading assistant turns (e.g. initial welcome greeting),
 * and merges consecutive same-role messages.
 */
function normalizeStrictTurnMessages(
  messages: readonly ChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = m.content.trim();
    if (!content) continue;
    if (out.length === 0 && m.role === 'assistant') continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${content}`;
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

async function* iterateSseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    for (const rawLine of buffer.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (line.startsWith('data:')) {
        yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamLlmChat(params: StreamChatParams): AsyncGenerator<LlmStreamChunk> {
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(params.baseUrl);

  if (params.provider === 'anthropic-compatible') {
    const systemText = params.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const anthropicMessages = normalizeStrictTurnMessages(params.messages);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (params.apiKey) headers['x-api-key'] = params.apiKey;

    const response = await fetchFn(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 768,
        temperature: params.temperature ?? 0.7,
        stream: true,
        ...(systemText ? { system: systemText } : {}),
        messages: anthropicMessages,
      }),
      signal: params.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Anthropic-compatible stream HTTP ${response.status}`);
    }
    for await (const data of iterateSseDataLines(response.body)) {
      if (!data || data === '[DONE]') continue;
      let parsed: { type?: string; delta?: { type?: string; text?: string } };
      try {
        parsed = JSON.parse(data) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        yield { delta: parsed.delta.text, done: false };
      }
    }
    yield { delta: '', done: true };
    return;
  }

  if (params.provider === 'gemini-compatible') {
    const systemText = params.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = normalizeStrictTurnMessages(params.messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const modelId = stripGeminiModelPrefix(params.model);
    const url = `${baseUrl}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (params.apiKey) headers['x-goog-api-key'] = params.apiKey;

    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents,
        generationConfig: {
          temperature: params.temperature ?? 0.7,
          maxOutputTokens: params.maxTokens ?? 768,
        },
      }),
      signal: params.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Gemini-compatible stream HTTP ${response.status}`);
    }
    for await (const data of iterateSseDataLines(response.body)) {
      if (!data || data === '[DONE]') continue;
      let parsed: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      try {
        parsed = JSON.parse(data) as typeof parsed;
      } catch {
        continue;
      }
      const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text) yield { delta: text, done: false };
    }
    yield { delta: '', done: true };
    return;
  }

  // Default: OpenAI-compatible (local magpie:3425, OpenAI, DeepSeek, Ollama, vLLM)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

  const response = await fetchFn(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      stream: true,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 768,
      messages: params.messages,
    }),
    signal: params.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`OpenAI-compatible stream HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    if (text) yield { delta: text, done: false };
    yield { delta: '', done: true };
    return;
  }

  for await (const data of iterateSseDataLines(response.body)) {
    if (!data) continue;
    if (data === '[DONE]') {
      yield { delta: '', done: true };
      return;
    }
    let parsed: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      continue;
    }
    const delta = parsed.choices?.[0]?.delta?.content ?? '';
    if (delta) {
      yield { delta, done: false };
    }
  }
  yield { delta: '', done: true };
}

export async function listAvailableModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalogEntry[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetchImpl(`${stripTrailingSlash(baseUrl)}/models`, {
    method: 'GET',
    headers,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Model catalog HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };
  return (payload.data ?? [])
    .filter((entry): entry is { id: string; owned_by?: string } => typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id,
      ...(entry.owned_by ? { ownedBy: entry.owned_by } : {}),
    }));
}

export async function chatWithImage(params: VisionChatParams): Promise<string> {
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(params.baseUrl);
  const boxHint = params.focusBox
    ? `\n[Jev Focus Box ROI: top=${params.focusBox.top.toFixed(2)}, left=${params.focusBox.left.toFixed(2)}, bottom=${params.focusBox.bottom.toFixed(2)}, right=${params.focusBox.right.toFixed(2)}]`
    : '';
  const combinedPrompt = `${params.userPrompt}${boxHint}`;

  if (params.provider === 'anthropic-compatible') {
    const { mimeType, base64 } = parseDataUrl(params.imageDataUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (params.apiKey) headers['x-api-key'] = params.apiKey;

    const response = await fetchFn(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 512,
        ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
              { type: 'text', text: combinedPrompt },
            ],
          },
        ],
      }),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`Anthropic Vision VLM HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (payload.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }

  if (params.provider === 'gemini-compatible') {
    const { mimeType, base64 } = parseDataUrl(params.imageDataUrl);
    const modelId = stripGeminiModelPrefix(params.model);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (params.apiKey) headers['x-goog-api-key'] = params.apiKey;

    const response = await fetchFn(`${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(params.systemPrompt ? { systemInstruction: { parts: [{ text: params.systemPrompt }] } } : {}),
        contents: [
          {
            role: 'user',
            parts: [{ text: combinedPrompt }, { inlineData: { mimeType, data: base64 } }],
          },
        ],
        generationConfig: {
          maxOutputTokens: params.maxTokens ?? 512,
        },
      }),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`Gemini Vision VLM HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

  const response = await fetchFn(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 512,
      messages: [
        { role: 'system', content: params.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: combinedPrompt },
            { type: 'image_url', image_url: { url: params.imageDataUrl } },
          ],
        },
      ],
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(`Vision VLM HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() ?? '';
}
