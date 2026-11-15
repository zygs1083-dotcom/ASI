import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, Conversation, ConversationSummary, ModelRef } from '../../shared/types';
import { ensureDir, readJsonFile, writeJsonAtomic } from './json-file';

const ID_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_TITLE = '新对话';

function isConversation(value: unknown): value is Conversation {
  const c = value as Conversation;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.id === 'string' &&
    ID_RE.test(c.id) &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number' &&
    (c.model === null || (typeof c.model === 'object' && typeof c.model.providerId === 'string')) &&
    Array.isArray(c.messages)
  );
}

export class ConversationStore {
  private readonly dir: string;
  private readonly conversations = new Map<string, Conversation>();
  private lastTimestamp = 0;

  constructor(dataDirectory: string) {
    this.dir = join(dataDirectory, 'conversations');
    ensureDir(this.dir);
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const id = file.slice(0, -'.json'.length);
      if (!ID_RE.test(id)) {
        continue;
      }
      const conv = readJsonFile<unknown>(join(this.dir, file));
      if (!isConversation(conv) || conv.id !== id) {
        throw new Error(`数据文件损坏，会话格式无效：${join(this.dir, file)}`);
      }
      // 启动恢复：盘上遗留的 streaming 没有对应的活动请求，转成 aborted 并立即写回，
      // 否则界面会把这条消息永久当成"进行中"
      let recovered = false;
      for (const m of conv.messages) {
        if (m.status === 'streaming') {
          m.status = 'aborted';
          m.error = '已停止';
          recovered = true;
        }
      }
      if (recovered) {
        this.persist(conv);
      }
      this.conversations.set(conv.id, conv);
      this.lastTimestamp = Math.max(this.lastTimestamp, conv.createdAt, conv.updatedAt);
    }
  }

  private fileFor(id: string): string {
    if (!ID_RE.test(id)) {
      throw new Error(`无效的会话 ID：${id}`);
    }
    return join(this.dir, `${id}.json`);
  }

  private require(id: string): Conversation {
    this.fileFor(id);
    const conv = this.conversations.get(id);
    if (!conv) {
      throw new Error(`会话不存在：${id}`);
    }
    return conv;
  }

  private touch(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  private persist(conv: Conversation): void {
    // 落盘快照里的 streaming 一律转成 aborted：进程退出/崩溃后没有活动请求能推进它，
    // 盘上若留 streaming，重启后会永久卡在"进行中"。内存中的实时状态不受影响。
    const snapshot = structuredClone(conv);
    for (const m of snapshot.messages) {
      if (m.status === 'streaming') {
        m.status = 'aborted';
        m.error = '已停止';
      }
    }
    writeJsonAtomic(this.fileFor(conv.id), snapshot);
  }

  create(model: ModelRef | null = null): Conversation {
    const now = this.touch();
    const conv: Conversation = {
      id: randomUUID(),
      title: DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      model: model ? structuredClone(model) : null,
      messages: [],
    };
    // 先落盘成功再提交内存，写失败时内存与盘上保持一致
    this.persist(conv);
    this.conversations.set(conv.id, conv);
    return structuredClone(conv);
  }

  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  get(id: string): Conversation | null {
    this.fileFor(id);
    const conv = this.conversations.get(id);
    return conv ? structuredClone(conv) : null;
  }

  rename(id: string, title: string): void {
    const conv = this.require(id);
    const next: Conversation = { ...conv, title, updatedAt: this.touch() };
    this.persist(next);
    this.conversations.set(id, next);
  }

  setModel(id: string, model: ModelRef): void {
    const conv = this.require(id);
    const next: Conversation = { ...conv, model: structuredClone(model), updatedAt: this.touch() };
    this.persist(next);
    this.conversations.set(id, next);
  }

  remove(id: string): void {
    const file = this.fileFor(id);
    rmSync(file, { force: true });
    this.conversations.delete(id);
  }

  save(conv: Conversation): void {
    const snapshot = structuredClone(conv);
    this.persist(snapshot);
    this.conversations.set(snapshot.id, snapshot);
  }

  /** 仅供 ChatService 使用：只改内存，不落盘（配 flush 使用） */
  appendMessages(id: string, messages: ChatMessage[]): void {
    const conv = this.require(id);
    const hadUser = conv.messages.some((m) => m.role === 'user');
    const clones = structuredClone(messages);
    conv.messages.push(...clones);
    if (!hadUser && conv.title === DEFAULT_TITLE) {
      const firstUser = clones.find((m) => m.role === 'user');
      if (firstUser) {
        conv.title = Array.from(firstUser.text).slice(0, 30).join('');
      }
    }
    conv.updatedAt = this.touch();
  }

  /** 仅供 ChatService 使用：只改内存，不落盘（配 flush 使用）；要求最后一条仍是 expectedId */
  replaceLastMessage(id: string, expectedId: string, message: ChatMessage): void {
    const conv = this.require(id);
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.id !== expectedId) {
      throw new Error(`最后一条消息已变化，无法替换：${expectedId}`);
    }
    conv.messages[conv.messages.length - 1] = structuredClone(message);
    conv.updatedAt = this.touch();
  }

  /** 仅供 ChatService 使用：只改内存，不落盘 */
  updateMessage(id: string, message: ChatMessage): void {
    const conv = this.require(id);
    const index = conv.messages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      throw new Error(`消息不存在：${message.id}`);
    }
    conv.messages[index] = structuredClone(message);
  }

  flush(id: string): void {
    this.persist(this.require(id));
  }
}
