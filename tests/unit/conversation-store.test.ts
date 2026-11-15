import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../../src/main/stores/conversation-store';
import type { ChatMessage } from '../../src/shared/types';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asi-conversation-store-'));
  dirs.push(dir);
  return dir;
}

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    text: '你好',
    createdAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ConversationStore', () => {
  it('creates a conversation persisted to conversations/<id>.json', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create({ providerId: 'p', modelId: 'm' });
    expect(conv.title).toBe('新对话');
    expect(conv.messages).toEqual([]);
    expect(conv.model).toEqual({ providerId: 'p', modelId: 'm' });
    const raw = JSON.parse(readFileSync(join(dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(raw.id).toBe(conv.id);
    expect(raw.title).toBe('新对话');
  });

  it('defaults model to null', () => {
    const store = new ConversationStore(tempDir());
    expect(store.create().model).toBeNull();
  });

  it('lists summaries newest updatedAt first, deterministic on equal timestamps', () => {
    const store = new ConversationStore(tempDir());
    const a = store.create();
    const b = store.create();
    expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
    store.rename(a.id, 'A');
    expect(store.list().map((s) => s.id)).toEqual([a.id, b.id]);
    const summaries = store.list();
    for (const s of summaries) {
      expect(Object.keys(s).sort()).toEqual(['id', 'title', 'updatedAt']);
    }
  });

  it('get returns null for a missing conversation', () => {
    const store = new ConversationStore(tempDir());
    expect(store.get('missing')).toBeNull();
  });

  it('rename persists the new title', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    store.rename(conv.id, '改名后');
    const raw = JSON.parse(readFileSync(join(dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(raw.title).toBe('改名后');
    expect(store.get(conv.id)?.title).toBe('改名后');
  });

  it('setModel persists the model ref snapshot', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    const model = { providerId: 'p2', modelId: 'm2' };
    store.setModel(conv.id, model);
    model.modelId = 'mutated';
    const raw = JSON.parse(readFileSync(join(dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(raw.model).toEqual({ providerId: 'p2', modelId: 'm2' });
  });

  it('remove deletes the file and is idempotent', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    const file = join(dir, 'conversations', `${conv.id}.json`);
    store.remove(conv.id);
    expect(existsSync(file)).toBe(false);
    expect(store.get(conv.id)).toBeNull();
    expect(() => store.remove(conv.id)).not.toThrow();
  });

  it('appendMessages sets the title from the first user message, capped at 30 characters', () => {
    const store = new ConversationStore(tempDir());
    const conv = store.create();
    const text = `一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十尾巴🙂`;
    store.appendMessages(conv.id, [
      msg({ text }),
      msg({ role: 'assistant', text: 'reply', status: 'streaming' }),
    ]);
    const title = store.get(conv.id)?.title ?? '';
    expect(Array.from(title)).toHaveLength(30);
    expect(title).toBe(Array.from(text).slice(0, 30).join(''));
  });

  it('keeps an existing title once a user message or rename already happened', () => {
    const store = new ConversationStore(tempDir());
    const conv = store.create();
    store.appendMessages(conv.id, [msg({ text: '第一条' })]);
    const firstTitle = store.get(conv.id)?.title;
    expect(firstTitle).toBe('第一条');
    store.appendMessages(conv.id, [msg({ text: '第二条' })]);
    expect(store.get(conv.id)?.title).toBe('第一条');

    const renamed = store.create();
    store.rename(renamed.id, '自定义标题');
    store.appendMessages(renamed.id, [msg({ text: 'hello' })]);
    expect(store.get(renamed.id)?.title).toBe('自定义标题');
  });

  it('appendMessages is memory-only until flush', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    store.appendMessages(conv.id, [msg({ id: 'm1', text: '内存中' })]);
    const before = JSON.parse(readFileSync(join(dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(before.messages).toHaveLength(0);
    store.flush(conv.id);
    const after = JSON.parse(readFileSync(join(dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0].text).toBe('内存中');
    expect(after.title).toBe('内存中');
  });

  it('updateMessage replaces by id without dropping a concurrent rename or model', () => {
    const store = new ConversationStore(tempDir());
    const conv = store.create({ providerId: 'p', modelId: 'm' });
    store.appendMessages(conv.id, [
      msg({ id: 'u1' }),
      msg({ id: 'a1', role: 'assistant', text: 'partial', status: 'streaming' }),
    ]);
    store.rename(conv.id, '保留我');
    store.setModel(conv.id, { providerId: 'p2', modelId: 'm2' });
    store.updateMessage(conv.id, {
      id: 'a1',
      role: 'assistant',
      text: 'full reply',
      createdAt: 2,
      status: 'done',
    });
    const got = store.get(conv.id);
    expect(got?.title).toBe('保留我');
    expect(got?.model).toEqual({ providerId: 'p2', modelId: 'm2' });
    expect(got?.messages.find((m) => m.id === 'a1')?.text).toBe('full reply');
    expect(got?.messages.find((m) => m.id === 'a1')?.status).toBe('done');
  });

  it('updateMessage throws for an unknown message id', () => {
    const store = new ConversationStore(tempDir());
    const conv = store.create();
    expect(() => store.updateMessage(conv.id, msg({ id: 'ghost' }))).toThrow();
  });

  it('rejects path-traversal conversation ids', () => {
    const store = new ConversationStore(tempDir());
    for (const bad of ['../evil', 'a/b', '..', 'x.json', 'a b', 'a\\b']) {
      expect(() => store.get(bad)).toThrow();
      expect(() => store.remove(bad)).toThrow();
      expect(() => store.rename(bad, 't')).toThrow();
      expect(() => store.appendMessages(bad, [])).toThrow();
      expect(() => store.flush(bad)).toThrow();
    }
  });

  it('chat seams throw for missing or removed conversations, preventing resurrection', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    const file = join(dir, 'conversations', `${conv.id}.json`);
    store.remove(conv.id);
    expect(() => store.appendMessages(conv.id, [msg()])).toThrow();
    expect(() => store.updateMessage(conv.id, msg())).toThrow();
    expect(() => store.flush(conv.id)).toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it('hydrates persisted conversations on construction', () => {
    const dir = tempDir();
    const first = new ConversationStore(dir);
    const a = first.create();
    first.appendMessages(a.id, [msg({ id: 'm1', text: '持久化' })]);
    first.flush(a.id);
    const second = new ConversationStore(dir);
    const loaded = second.get(a.id);
    expect(loaded?.title).toBe('持久化');
    expect(loaded?.messages[0].id).toBe('m1');
    expect(second.list().map((s) => s.id)).toEqual([a.id]);
  });

  it('throws on malformed conversation files instead of silently resetting', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    const file = join(dir, 'conversations', `${conv.id}.json`);
    writeFileSync(file, '{{{', 'utf8');
    expect(() => new ConversationStore(dir)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{{{');
  });

  it('returns snapshots so caller mutations cannot alter stored state', () => {
    const store = new ConversationStore(tempDir());
    const conv = store.create();
    conv.title = 'mutated';
    conv.messages.push(msg());
    const got = store.get(conv.id);
    got?.messages.push(msg());
    const fresh = store.get(conv.id);
    expect(fresh?.title).toBe('新对话');
    expect(fresh?.messages).toEqual([]);
  });

  it('save upserts a full conversation for test seeding', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = {
      id: 'seed-1',
      title: 'Seeded',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [msg({ id: 'sm1', text: 'seeded msg' })],
    };
    store.save(conv);
    conv.messages.push(msg());
    expect(store.get('seed-1')?.messages).toHaveLength(1);
    const raw = JSON.parse(readFileSync(join(dir, 'conversations', 'seed-1.json'), 'utf8'));
    expect(raw.title).toBe('Seeded');
    expect(() => store.save({ ...conv, id: '../bad' })).toThrow();
  });

  it('leaves memory unchanged and no tmp files when a rename write fails', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    const conv = store.create();
    const file = join(dir, 'conversations', `${conv.id}.json`);
    // 用同名目录让 renameSync 失败
    rmSync(file);
    mkdirSync(file);
    expect(() => store.rename(conv.id, '新标题')).toThrow();
    expect(store.get(conv.id)?.title).toBe('新对话');
    const leftovers = readdirSync(join(dir, 'conversations')).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('leaves memory unchanged when create cannot write the conversation file', () => {
    const dir = tempDir();
    const store = new ConversationStore(dir);
    // conversations 变成普通文件 → tmp 写不进 → create 失败
    rmSync(join(dir, 'conversations'), { recursive: true });
    writeFileSync(join(dir, 'conversations'), 'not a dir', 'utf8');
    expect(() => store.create()).toThrow();
    expect(store.list()).toEqual([]);
  });
});
