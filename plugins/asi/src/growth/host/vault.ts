/**
 * Local Plain-Text `SKILL.md` Library, Draft Store, 60-Day Metabolism Tracker,
 * and Safe Workspace Exporter (`asi-growth`).
 *
 * Storage layout under `<storageRoot>`:
 * - `catalog.json`: structured metadata for drafts, active/disabled skills, and archived skills
 * - `journal.jsonl`: bounded synthesis & lifecycle audit log
 * - `skills/active/<name>/SKILL.md`: plain-text standard `SKILL.md` for installed skills
 * - `skills/drafts/<draftId>/<name>/SKILL.md`: plain-text standard `SKILL.md` for pending drafts
 * - `skills/archived/<name>/SKILL.md`: plain-text standard `SKILL.md` for archived skills
 *
 * Zero executable scripts are ever written. All writes to user workspaces
 * (`.agents/skills/<name>/SKILL.md`) are strictly user-initiated,
 * symlink-checked via `lstat`, root-guarded, and redacted via `sanitizeForModel`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fastSafeRealpath } from '../../shared/internal-guards.js';
import {
  isValidSkillName,
  maskHomeDir,
  parseSkillMarkdown,
  renderSkillMarkdown,
  sanitizeSkillText,
  validateSkillDocument,
} from '../shared/skill-spec.js';
import type {
  ArchivedSkillViewItem,
  GrowthSynthesisRecord,
  GrowthSynthesisTrigger,
  SkillDraftViewItem,
  SkillExportResult,
  SkillInstalledStatus,
  SkillScope,
  SkillViewItem,
} from '../shared/types.js';
import { STALE_SKILL_ZERO_USAGE_MS } from './evaluator.js';

const MAX_JOURNAL_ENTRIES = 100;

const FORBIDDEN_EXPORT_PATH_RE =
  /(?:^|[\\/])(?:\.secrets|\.ssh|\.gnupg|\.aws|\.Trash|asi-(?:sense|needs|sleep|care|growth|intuition|tom|dream)|(?:sense|needs|sleep|care|growth|intuition|tom|dream)[\\/](?:sandbox|vault|skills))(?:[\\/]|$)/i;

export interface StoredDraftRecord {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  markdown: string;
  scope: SkillScope;
  workspacePath?: string;
  targetVersion: number;
  isRevision: boolean;
  revisesSkillName?: string;
  baseVersion?: number;
  baseMarkdown?: string;
  topicKey: string;
  evidenceIds: string[];
  memoryCount: number;
  trajectoryCount: number;
  evidenceSummary: string;
  evidenceSignature: string;
  createdAt: number;
  updatedAt: number;
  trigger: GrowthSynthesisTrigger;
}

export interface StoredInstalledSkillRecord {
  name: string;
  version: number;
  status: SkillInstalledStatus;
  scope: SkillScope;
  workspacePath?: string;
  description: string;
  whenToUse?: string;
  markdown: string;
  topicKey: string;
  evidenceIds: string[];
  approvedAt: number;
  updatedAt: number;
  invocationCount: number;
  lastInvokedAt: number | null;
  evaluatedTurns: number;
  completedTurns: number;
  exportedWorkspaces: string[];
}

export interface StoredArchivedSkillRecord {
  name: string;
  version: number;
  scope: SkillScope;
  workspacePath?: string;
  description: string;
  whenToUse?: string;
  markdown: string;
  topicKey: string;
  evidenceIds: string[];
  approvedAt: number;
  archivedAt: number;
  invocationCount: number;
  lastInvokedAt: number | null;
  evaluatedTurns: number;
  completedTurns: number;
  exportedWorkspaces: string[];
}

interface PersistedCatalogFile {
  drafts?: StoredDraftRecord[];
  skills?: StoredInstalledSkillRecord[];
  archived?: StoredArchivedSkillRecord[];
}

function safeRealpath(target: string): string {
  return fastSafeRealpath(target);
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(prefix);
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function checkSafeWorkspaceRootBounds(
  rawWorkspacePath: string,
  homeDir: string | undefined,
  excludedInternalRoots: readonly string[],
  requireExistingDirectory: boolean,
): string {
  if (typeof rawWorkspacePath !== 'string' || !rawWorkspacePath.trim()) {
    throw new Error('Target workspace path is required');
  }
  const trimmed = rawWorkspacePath.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error('Target workspace path must be an absolute directory path');
  }
  const resolved = resolve(trimmed);
  if (resolved === '/' || resolved === sep) {
    throw new Error('Refusing to use filesystem root as workspace');
  }

  const systemForbiddenPrefixes = ['System', 'Library', 'usr', 'bin', 'sbin', 'etc', 'var', 'private']
    .map((seg) => `${sep}${seg}`)
    .filter(
      (p) =>
        !(
          resolved.startsWith(`${sep}tmp${sep}`) ||
          resolved.startsWith(`${sep}private${sep}tmp${sep}`) ||
          resolved.startsWith(`${sep}var${sep}folders${sep}`) ||
          resolved.startsWith(`${sep}private${sep}var${sep}folders${sep}`)
        ),
    );

  for (const sysPrefix of systemForbiddenPrefixes) {
    if (resolved === sysPrefix || resolved.startsWith(`${sysPrefix}${sep}`)) {
      throw new Error('Refusing to target protected system directory');
    }
  }

  if (homeDir) {
    const normHome = resolve(homeDir);
    const realHome = safeRealpath(normHome);
    if (resolved === normHome || safeRealpath(resolved) === realHome) {
      throw new Error('Refusing to target home directory root directly');
    }
  }

  if (FORBIDDEN_EXPORT_PATH_RE.test(resolved)) {
    throw new Error('Refusing to target sensitive or internal directory');
  }

  const realTarget = safeRealpath(resolved);
  for (const internalRoot of excludedInternalRoots) {
    if (!internalRoot) continue;
    const normInt = resolve(internalRoot);
    if (isSameOrInside(normInt, resolved) || isSameOrInside(safeRealpath(normInt), realTarget)) {
      throw new Error('Refusing to target internal ASI storage directory');
    }
  }

  if (existsSync(resolved)) {
    const st = lstatSync(resolved);
    if (st.isSymbolicLink()) {
      throw new Error('Refusing to target symbolic link workspace root');
    }
    if (!st.isDirectory()) {
      throw new Error('Target workspace path is not a directory');
    }
    return realTarget;
  }
  if (requireExistingDirectory) {
    throw new Error('Target workspace directory does not exist');
  }
  return resolved;
}

export function validateSafeWorkspaceTarget(
  rawWorkspacePath: string,
  homeDir: string | undefined,
  excludedInternalRoots: readonly string[],
): string {
  return checkSafeWorkspaceRootBounds(rawWorkspacePath, homeDir, excludedInternalRoots, true);
}

export function validateSafeScopeWorkspacePath(
  rawWorkspacePath: string,
  homeDir: string | undefined,
  excludedInternalRoots: readonly string[],
): string {
  return checkSafeWorkspaceRootBounds(rawWorkspacePath, homeDir, excludedInternalRoots, false);
}

export class SkillVault {
  private readonly catalogPath: string;
  private readonly journalPath: string;
  private readonly skillsRoot: string;

  private readonly drafts = new Map<string, StoredDraftRecord>();
  private readonly skills = new Map<string, StoredInstalledSkillRecord>();
  private readonly archived = new Map<string, StoredArchivedSkillRecord>();
  private journal: GrowthSynthesisRecord[] = [];
  private opChain: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly storageRoot: string,
    private readonly homeDir?: string,
    private readonly excludedInternalRoots: readonly string[] = [],
  ) {
    this.catalogPath = join(storageRoot, 'catalog.json');
    this.journalPath = join(storageRoot, 'journal.jsonl');
    this.skillsRoot = join(storageRoot, 'skills');
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  validateScopeWorkspace(rawWorkspacePath: string): string {
    return validateSafeScopeWorkspacePath(rawWorkspacePath, this.homeDir, [
      this.storageRoot,
      ...this.excludedInternalRoots,
    ]);
  }

  activeSkillFilePath(name: string): string {
    return join(this.skillsRoot, 'active', name, 'SKILL.md');
  }

  draftSkillFilePath(draftId: string, name: string): string {
    return join(this.skillsRoot, 'drafts', draftId, name, 'SKILL.md');
  }

  archivedSkillFilePath(name: string): string {
    return join(this.skillsRoot, 'archived', name, 'SKILL.md');
  }

  async load(): Promise<void> {
    return this.runExclusive(async () => {
      await mkdir(this.skillsRoot, { recursive: true });
      try {
        const raw = await readFile(this.catalogPath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedCatalogFile;
        this.drafts.clear();
        this.skills.clear();
        this.archived.clear();

        for (const d of parsed.drafts ?? []) {
          if (d?.id && isValidSkillName(d.name)) {
            const check = parseSkillMarkdown(d.markdown, this.homeDir);
            if (check.valid && check.document) {
              this.drafts.set(d.id, {
                ...d,
                name: check.document.name,
                description: check.document.description,
                ...(check.document.whenToUse ? { whenToUse: check.document.whenToUse } : {}),
                markdown: renderSkillMarkdown(check.document, this.homeDir),
                evidenceSummary: sanitizeSkillText(d.evidenceSummary ?? '', 240, this.homeDir),
              });
            }
          }
        }

        for (const s of parsed.skills ?? []) {
          if (s && isValidSkillName(s.name)) {
            const rawMd =
              typeof s.markdown === 'string' && s.markdown.trim()
                ? s.markdown
                : await readFile(this.activeSkillFilePath(s.name), 'utf8').catch(() => '');
            const check = parseSkillMarkdown(rawMd, this.homeDir);
            if (check.valid && check.document) {
              this.skills.set(s.name, {
                ...s,
                description: check.document.description,
                ...(check.document.whenToUse ? { whenToUse: check.document.whenToUse } : {}),
                markdown: renderSkillMarkdown(check.document, this.homeDir),
                exportedWorkspaces: (s.exportedWorkspaces ?? []).map((w) => sanitizeSkillText(w, 200, this.homeDir)),
              });
            }
          }
        }

        for (const a of parsed.archived ?? []) {
          if (a && isValidSkillName(a.name)) {
            const check = parseSkillMarkdown(a.markdown, this.homeDir);
            if (check.valid && check.document) {
              this.archived.set(a.name, {
                ...a,
                description: check.document.description,
                ...(check.document.whenToUse ? { whenToUse: check.document.whenToUse } : {}),
                markdown: renderSkillMarkdown(check.document, this.homeDir),
              });
            }
          }
        }
      } catch {
        // Fresh catalog
      }

      try {
        const rawJournal = await readFile(this.journalPath, 'utf8');
        const lines = rawJournal.split('\n').filter((l) => l.trim().length > 0);
        const parsedRecords: GrowthSynthesisRecord[] = [];
        for (const line of lines.slice(-MAX_JOURNAL_ENTRIES)) {
          try {
            const rec = JSON.parse(line) as GrowthSynthesisRecord;
            if (rec?.id && typeof rec.at === 'number') {
              parsedRecords.push({
                ...rec,
                summary: sanitizeSkillText(rec.summary ?? '', 260, this.homeDir),
              });
            }
          } catch {
            // Skip malformed line
          }
        }
        this.journal = parsedRecords;
      } catch {
        this.journal = [];
      }

      await this.syncExternalDiskEditsUnlocked();
    });
  }

  /**
   * Reconcile manual user edits made directly to `skills/active/<name>/SKILL.md`,
   * enforcing `agentskills` spec validation and `sanitizeForModel` redaction.
   */
  async syncExternalDiskEdits(): Promise<boolean> {
    return this.runExclusive(() => this.syncExternalDiskEditsUnlocked());
  }

  private async syncExternalDiskEditsUnlocked(): Promise<boolean> {
    let changed = false;
    for (const name of [...this.skills.keys()]) {
      const snapshotBeforeRead = this.skills.get(name);
      if (!snapshotBeforeRead) continue;
      const filePath = this.activeSkillFilePath(name);
      try {
        const diskRaw = await readFile(filePath, 'utf8');
        const latest = this.skills.get(name);
        if (!latest || diskRaw === latest.markdown) continue;
        const parsed = parseSkillMarkdown(diskRaw, this.homeDir);
        if (!parsed.valid || !parsed.document || parsed.document.name !== name) continue;
        const cleanMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);
        const nextRecord: StoredInstalledSkillRecord = {
          ...latest,
          description: parsed.document.description,
          markdown: cleanMarkdown,
          updatedAt: Date.now(),
        };
        if (parsed.document.whenToUse) {
          nextRecord.whenToUse = parsed.document.whenToUse;
        } else {
          delete nextRecord.whenToUse;
        }
        this.skills.set(name, nextRecord);
        if (cleanMarkdown !== diskRaw) {
          await atomicWriteUtf8(filePath, cleanMarkdown);
        }
        changed = true;
      } catch {
        // Restore missing disk file ONLY if skill is still installed (never resurrect archived/deleted skills)
        const latest = this.skills.get(name);
        if (latest) {
          await atomicWriteUtf8(filePath, latest.markdown).catch(() => undefined);
        }
      }
    }
    if (changed) {
      await this.persistCatalog();
    }
    return changed;
  }

  private persistCatalog(): Promise<void> {
    const run = async () => {
      await mkdir(this.storageRoot, { recursive: true });
      const payload: PersistedCatalogFile = {
        drafts: [...this.drafts.values()],
        skills: [...this.skills.values()],
        archived: [...this.archived.values()],
      };
      await atomicWriteUtf8(this.catalogPath, `${JSON.stringify(payload, null, 2)}\n`);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  async waitForIdle(): Promise<void> {
    await this.opChain;
    await this.writeChain;
  }

  takenSkillNames(): Set<string> {
    return new Set<string>([
      ...this.skills.keys(),
      ...this.archived.keys(),
      ...[...this.drafts.values()].map((d) => d.name),
    ]);
  }

  listDraftRecords(): StoredDraftRecord[] {
    return [...this.drafts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listSkillRecords(): StoredInstalledSkillRecord[] {
    return [...this.skills.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  listActiveMountableSkills(): StoredInstalledSkillRecord[] {
    return [...this.skills.values()].filter((s) => s.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  }

  getActiveSkill(name: string): StoredInstalledSkillRecord | undefined {
    const found = this.skills.get(name);
    return found?.status === 'active' ? found : undefined;
  }

  getInstalledSkill(name: string): StoredInstalledSkillRecord | undefined {
    return this.skills.get(name);
  }

  getDraft(draftId: string): StoredDraftRecord | undefined {
    return this.drafts.get(draftId);
  }

  listArchivedRecords(): StoredArchivedSkillRecord[] {
    return [...this.archived.values()].sort((a, b) => b.archivedAt - a.archivedAt);
  }

  recentJournal(limit = 10): GrowthSynthesisRecord[] {
    return [...this.journal].slice(-limit).reverse();
  }

  async appendJournal(record: GrowthSynthesisRecord): Promise<GrowthSynthesisRecord> {
    const clean: GrowthSynthesisRecord = {
      ...record,
      summary: sanitizeSkillText(record.summary, 260, this.homeDir),
    };
    this.journal.push(clean);
    if (this.journal.length > MAX_JOURNAL_ENTRIES) {
      this.journal = this.journal.slice(-MAX_JOURNAL_ENTRIES);
    }
    const serialized = `${this.journal.map((r) => JSON.stringify(r)).join('\n')}\n`;
    await atomicWriteUtf8(this.journalPath, serialized);
    return clean;
  }

  async saveDraft(draft: StoredDraftRecord): Promise<StoredDraftRecord> {
    return this.runExclusive(async () => {
      const parsed = parseSkillMarkdown(draft.markdown, this.homeDir);
      if (!parsed.valid || !parsed.document) {
        throw new Error(`Invalid SKILL.md draft: ${parsed.errors.join('; ')}`);
      }
      const checkedWs =
        draft.scope === 'workspace' && draft.workspacePath
          ? this.validateScopeWorkspace(draft.workspacePath)
          : undefined;
      const cleanMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);
      const stored: StoredDraftRecord = {
        ...draft,
        name: parsed.document.name,
        description: parsed.document.description,
        ...(parsed.document.whenToUse ? { whenToUse: parsed.document.whenToUse } : {}),
        markdown: cleanMarkdown,
        ...(checkedWs ? { workspacePath: checkedWs } : {}),
        evidenceSummary: sanitizeSkillText(draft.evidenceSummary, 240, this.homeDir),
      };
      if (stored.scope !== 'workspace') delete stored.workspacePath;
      this.drafts.set(stored.id, stored);
      await atomicWriteUtf8(this.draftSkillFilePath(stored.id, stored.name), cleanMarkdown);
      await this.persistCatalog();
      return stored;
    });
  }

  async updateDraft(
    draftId: string,
    patch: { markdown?: string; scope?: SkillScope; workspacePath?: string },
    now: number,
  ): Promise<StoredDraftRecord> {
    return this.runExclusive(async () => {
      const existing = this.drafts.get(draftId);
      if (!existing) throw new Error('Draft not found');

      let nextName = existing.name;
      let nextDesc = existing.description;
      let nextWhen = existing.whenToUse;
      let nextMarkdown = existing.markdown;

      if (patch.markdown !== undefined) {
        const parsed = parseSkillMarkdown(patch.markdown, this.homeDir);
        if (!parsed.valid || !parsed.document) {
          throw new Error(`SKILL.md 校验未通过: ${parsed.errors.join('; ')}`);
        }
        if (existing.isRevision && existing.revisesSkillName && parsed.document.name !== existing.revisesSkillName) {
          throw new Error(`修订草案名称必须保持为 ${existing.revisesSkillName}`);
        }
        if (!existing.isRevision && parsed.document.name !== existing.name) {
          const conflictingDraft = [...this.drafts.values()].some(
            (d) => d.id !== draftId && d.name === parsed.document?.name,
          );
          if (this.skills.has(parsed.document.name) || this.archived.has(parsed.document.name) || conflictingDraft) {
            throw new Error(`技能名称 ${parsed.document.name} 已存在`);
          }
        }
        nextName = parsed.document.name;
        nextDesc = parsed.document.description;
        nextWhen = parsed.document.whenToUse;
        nextMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);
      }

      const nextScope = patch.scope ?? existing.scope;
      const rawNextWs =
        nextScope === 'workspace'
          ? patch.workspacePath?.trim() || existing.workspacePath?.trim() || undefined
          : undefined;
      if (nextScope === 'workspace' && !rawNextWs) {
        throw new Error('工作区作用域必须指定目标工作区路径');
      }
      const nextWs = rawNextWs ? this.validateScopeWorkspace(rawNextWs) : undefined;

      if (nextName !== existing.name) {
        await rm(join(this.skillsRoot, 'drafts', existing.id, existing.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }

      const updated: StoredDraftRecord = {
        ...existing,
        name: nextName,
        description: nextDesc,
        ...(nextWhen ? { whenToUse: nextWhen } : {}),
        markdown: nextMarkdown,
        scope: nextScope,
        ...(nextWs ? { workspacePath: nextWs } : {}),
        updatedAt: now,
      };
      if (!nextWs) delete updated.workspacePath;
      if (!nextWhen) delete updated.whenToUse;

      this.drafts.set(draftId, updated);
      await atomicWriteUtf8(this.draftSkillFilePath(draftId, updated.name), updated.markdown);
      await this.persistCatalog();
      return updated;
    });
  }

  async approveDraft(draftId: string, now: number): Promise<StoredInstalledSkillRecord> {
    return this.runExclusive(async () => {
      const draft = this.drafts.get(draftId);
      if (!draft) throw new Error('Draft not found');

      const parsed = parseSkillMarkdown(draft.markdown, this.homeDir);
      if (!parsed.valid || !parsed.document) {
        throw new Error(`SKILL.md 校验未通过: ${parsed.errors.join('; ')}`);
      }
      const cleanCheck = validateSkillDocument(parsed.document, { expectedDirName: parsed.document.name });
      if (!cleanCheck.valid) {
        throw new Error(`SKILL.md 校验未通过: ${cleanCheck.errors.join('; ')}`);
      }

      const checkedWs =
        draft.scope === 'workspace' && draft.workspacePath
          ? this.validateScopeWorkspace(draft.workspacePath)
          : undefined;
      if (draft.scope === 'workspace' && !checkedWs) {
        throw new Error('工作区作用域必须指定目标工作区路径');
      }

      const cleanMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);
      const prevInstalled = this.skills.get(parsed.document.name);
      const prevArchived = this.archived.get(parsed.document.name);
      const prevRecord = prevInstalled ?? prevArchived;

      const record: StoredInstalledSkillRecord = {
        name: parsed.document.name,
        version: prevRecord ? Math.max(prevRecord.version + 1, draft.targetVersion) : draft.targetVersion,
        status: 'active',
        scope: draft.scope,
        ...(checkedWs ? { workspacePath: checkedWs } : {}),
        description: parsed.document.description,
        ...(parsed.document.whenToUse ? { whenToUse: parsed.document.whenToUse } : {}),
        markdown: cleanMarkdown,
        topicKey: draft.topicKey,
        evidenceIds: [...new Set([...(prevRecord?.evidenceIds ?? []), ...draft.evidenceIds])],
        approvedAt: prevInstalled?.approvedAt ?? now,
        updatedAt: now,
        invocationCount: prevRecord?.invocationCount ?? 0,
        lastInvokedAt: prevRecord?.lastInvokedAt ?? null,
        evaluatedTurns: prevRecord?.evaluatedTurns ?? 0,
        completedTurns: prevRecord?.completedTurns ?? 0,
        exportedWorkspaces: prevRecord?.exportedWorkspaces ?? [],
      };

      const wasArchived = this.archived.delete(record.name);
      this.skills.set(record.name, record);
      this.drafts.delete(draftId);

      await atomicWriteUtf8(this.activeSkillFilePath(record.name), cleanMarkdown);
      await rm(join(this.skillsRoot, 'drafts', draftId), { recursive: true, force: true }).catch(() => undefined);
      if (wasArchived) {
        await rm(join(this.skillsRoot, 'archived', record.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      await this.persistCatalog();
      return record;
    });
  }

  async rejectDraft(draftId: string): Promise<StoredDraftRecord> {
    return this.runExclusive(async () => {
      const draft = this.drafts.get(draftId);
      if (!draft) throw new Error('Draft not found');
      this.drafts.delete(draftId);
      await rm(join(this.skillsRoot, 'drafts', draftId), { recursive: true, force: true }).catch(() => undefined);
      await this.persistCatalog();
      return draft;
    });
  }

  async updateInstalledSkill(
    name: string,
    patch: { markdown?: string; scope?: SkillScope; workspacePath?: string },
    now: number,
  ): Promise<StoredInstalledSkillRecord> {
    return this.runExclusive(async () => {
      const existing = this.skills.get(name);
      if (!existing) throw new Error('Skill not found');

      let nextDesc = existing.description;
      let nextWhen = existing.whenToUse;
      let nextMarkdown = existing.markdown;

      if (patch.markdown !== undefined) {
        const parsed = parseSkillMarkdown(patch.markdown, this.homeDir);
        if (!parsed.valid || !parsed.document) {
          throw new Error(`SKILL.md 校验未通过: ${parsed.errors.join('; ')}`);
        }
        if (parsed.document.name !== name) {
          throw new Error(`已安装技能的 frontmatter name 必须保持为 ${name}`);
        }
        nextDesc = parsed.document.description;
        nextWhen = parsed.document.whenToUse;
        nextMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);
      }

      const nextScope = patch.scope ?? existing.scope;
      const rawNextWs =
        nextScope === 'workspace'
          ? patch.workspacePath?.trim() || existing.workspacePath?.trim() || undefined
          : undefined;
      if (nextScope === 'workspace' && !rawNextWs) {
        throw new Error('工作区作用域必须指定目标工作区路径');
      }
      const nextWs = rawNextWs ? this.validateScopeWorkspace(rawNextWs) : undefined;

      const updated: StoredInstalledSkillRecord = {
        ...existing,
        description: nextDesc,
        ...(nextWhen ? { whenToUse: nextWhen } : {}),
        markdown: nextMarkdown,
        scope: nextScope,
        ...(nextWs ? { workspacePath: nextWs } : {}),
        updatedAt: now,
      };
      if (!nextWs) delete updated.workspacePath;
      if (!nextWhen) delete updated.whenToUse;

      this.skills.set(name, updated);
      await atomicWriteUtf8(this.activeSkillFilePath(name), updated.markdown);
      await this.persistCatalog();
      return updated;
    });
  }

  async setSkillEnabled(name: string, enabled: boolean, now: number): Promise<StoredInstalledSkillRecord> {
    return this.runExclusive(async () => {
      const existing = this.skills.get(name);
      if (!existing) throw new Error('Skill not found');
      const updated: StoredInstalledSkillRecord = {
        ...existing,
        status: enabled ? 'active' : 'disabled',
        updatedAt: now,
      };
      this.skills.set(name, updated);
      await this.persistCatalog();
      return updated;
    });
  }

  async archiveSkill(name: string, now: number): Promise<StoredArchivedSkillRecord> {
    return this.runExclusive(async () => {
      const existing = this.skills.get(name);
      if (!existing) throw new Error('Skill not found');

      const archivedRec: StoredArchivedSkillRecord = {
        name: existing.name,
        version: existing.version,
        scope: existing.scope,
        ...(existing.workspacePath ? { workspacePath: existing.workspacePath } : {}),
        description: existing.description,
        ...(existing.whenToUse ? { whenToUse: existing.whenToUse } : {}),
        markdown: existing.markdown,
        topicKey: existing.topicKey,
        evidenceIds: [...existing.evidenceIds],
        approvedAt: existing.approvedAt,
        archivedAt: now,
        invocationCount: existing.invocationCount,
        lastInvokedAt: existing.lastInvokedAt,
        evaluatedTurns: existing.evaluatedTurns,
        completedTurns: existing.completedTurns,
        exportedWorkspaces: [...existing.exportedWorkspaces],
      };

      this.skills.delete(name);
      this.archived.set(name, archivedRec);

      await atomicWriteUtf8(this.archivedSkillFilePath(name), archivedRec.markdown);
      await rm(join(this.skillsRoot, 'active', name), { recursive: true, force: true }).catch(() => undefined);
      await this.persistCatalog();
      return archivedRec;
    });
  }

  async restoreArchivedSkill(name: string, now: number): Promise<StoredInstalledSkillRecord> {
    return this.runExclusive(async () => {
      const arch = this.archived.get(name);
      if (!arch) throw new Error('Archived skill not found');

      let rawMarkdown = arch.markdown;
      try {
        rawMarkdown = await readFile(this.archivedSkillFilePath(name), 'utf8');
      } catch {
        // Fallback to catalog copy
      }
      const parsed = parseSkillMarkdown(rawMarkdown, this.homeDir);
      if (!parsed.valid || !parsed.document) {
        throw new Error('Archived SKILL.md failed validation');
      }
      const cleanMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);

      const restored: StoredInstalledSkillRecord = {
        name: arch.name,
        version: arch.version,
        status: 'active',
        scope: arch.scope,
        ...(arch.workspacePath ? { workspacePath: arch.workspacePath } : {}),
        description: parsed.document.description,
        ...(parsed.document.whenToUse ? { whenToUse: parsed.document.whenToUse } : {}),
        markdown: cleanMarkdown,
        topicKey: arch.topicKey,
        evidenceIds: [...arch.evidenceIds],
        approvedAt: now,
        updatedAt: now,
        invocationCount: arch.invocationCount,
        lastInvokedAt: arch.lastInvokedAt,
        evaluatedTurns: arch.evaluatedTurns,
        completedTurns: arch.completedTurns,
        exportedWorkspaces: [...arch.exportedWorkspaces],
      };

      this.archived.delete(name);
      this.skills.set(name, restored);

      await atomicWriteUtf8(this.activeSkillFilePath(name), cleanMarkdown);
      await rm(join(this.skillsRoot, 'archived', name), { recursive: true, force: true }).catch(() => undefined);
      await this.persistCatalog();
      return restored;
    });
  }

  async deleteArchivedSkill(name: string): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.archived.has(name)) throw new Error('Archived skill not found');
      this.archived.delete(name);
      await rm(join(this.skillsRoot, 'archived', name), { recursive: true, force: true }).catch(() => undefined);
      await this.persistCatalog();
    });
  }

  recordInvocation(name: string, now: number): void {
    const existing = this.skills.get(name);
    if (!existing) return;
    this.skills.set(name, {
      ...existing,
      invocationCount: existing.invocationCount + 1,
      lastInvokedAt: now,
    });
    void this.persistCatalog();
  }

  recordTurnOutcome(name: string, completed: boolean, now: number, countInvocation = false): void {
    const existing = this.skills.get(name);
    if (!existing) return;
    this.skills.set(name, {
      ...existing,
      invocationCount: countInvocation ? existing.invocationCount + 1 : existing.invocationCount,
      lastInvokedAt: countInvocation ? now : (existing.lastInvokedAt ?? now),
      evaluatedTurns: existing.evaluatedTurns + 1,
      completedTurns: existing.completedTurns + (completed ? 1 : 0),
    });
    void this.persistCatalog();
  }

  async exportToWorkspace(name: string, rawWorkspacePath: string, now: number): Promise<SkillExportResult> {
    return this.runExclusive(async () => {
      if (!isValidSkillName(name)) {
        throw new Error('Invalid skill name');
      }
      const existing = this.skills.get(name);
      if (!existing) {
        throw new Error('Only approved skills can be exported to a workspace');
      }

      const safeWsRoot = validateSafeWorkspaceTarget(rawWorkspacePath, this.homeDir, [
        this.storageRoot,
        ...this.excludedInternalRoots,
      ]);

      const agentsDir = join(safeWsRoot, '.agents');
      const skillsDir = join(agentsDir, 'skills');
      const targetSkillDir = join(skillsDir, name);
      const targetFile = join(targetSkillDir, 'SKILL.md');

      for (const checkPath of [agentsDir, skillsDir, targetSkillDir, targetFile]) {
        const existingStat = await lstat(checkPath).catch(() => undefined);
        if (existingStat?.isSymbolicLink()) {
          throw new Error('Refusing to export through a symbolic link inside .agents/skills');
        }
      }

      await mkdir(targetSkillDir, { recursive: true });
      const realSkillDir = await stat(targetSkillDir).then(() => safeRealpath(targetSkillDir));
      if (!isSameOrInside(safeWsRoot, realSkillDir)) {
        throw new Error('Export target escaped workspace root');
      }

      const latestBeforeWrite = this.skills.get(name) ?? existing;
      const parsed = parseSkillMarkdown(latestBeforeWrite.markdown, this.homeDir);
      if (!parsed.valid || !parsed.document) {
        throw new Error('Skill failed validation before export');
      }
      const cleanMarkdown = renderSkillMarkdown(parsed.document, this.homeDir);
      await atomicWriteUtf8(targetFile, cleanMarkdown);

      const displayWs = sanitizeSkillText(maskHomeDir(safeWsRoot, this.homeDir), 200, this.homeDir);
      const latestAfterWrite = this.skills.get(name);
      if (latestAfterWrite) {
        const exportedWorkspaces = [...new Set([displayWs, ...latestAfterWrite.exportedWorkspaces])].slice(0, 12);
        this.skills.set(name, {
          ...latestAfterWrite,
          exportedWorkspaces,
          updatedAt: now,
        });
        await this.persistCatalog();
      }

      const displayPath = sanitizeSkillText(maskHomeDir(targetFile, this.homeDir), 240, this.homeDir);
      return {
        name,
        exportedPath: targetFile,
        displayPath,
        at: now,
      };
    });
  }

  toDraftView(d: StoredDraftRecord): SkillDraftViewItem {
    return {
      id: d.id,
      name: d.name,
      description: sanitizeSkillText(d.description, 1_024, this.homeDir),
      ...(d.whenToUse ? { whenToUse: sanitizeSkillText(d.whenToUse, 500, this.homeDir) } : {}),
      markdown: d.markdown,
      scope: d.scope,
      ...(d.workspacePath ? { workspacePath: d.workspacePath } : {}),
      ...(d.workspacePath
        ? { workspaceDisplay: sanitizeSkillText(maskHomeDir(d.workspacePath, this.homeDir), 200, this.homeDir) }
        : {}),
      targetVersion: d.targetVersion,
      isRevision: d.isRevision,
      ...(d.revisesSkillName ? { revisesSkillName: d.revisesSkillName } : {}),
      ...(d.baseVersion !== undefined ? { baseVersion: d.baseVersion } : {}),
      ...(d.baseMarkdown ? { baseMarkdown: d.baseMarkdown } : {}),
      topicKey: d.topicKey,
      evidenceIds: [...d.evidenceIds],
      memoryCount: d.memoryCount,
      trajectoryCount: d.trajectoryCount,
      evidenceSummary: sanitizeSkillText(d.evidenceSummary, 240, this.homeDir),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      trigger: d.trigger,
    };
  }

  toSkillView(s: StoredInstalledSkillRecord, now: number): SkillViewItem {
    const baselineAt = s.lastInvokedAt ?? s.approvedAt;
    const idleMs = Math.max(0, now - baselineAt);
    const stale = s.status === 'active' && idleMs >= STALE_SKILL_ZERO_USAGE_MS;
    const daysSinceLastUse = Math.floor(idleMs / 86_400_000);
    const turnCompletionRate =
      s.evaluatedTurns > 0 ? Math.round((s.completedTurns / s.evaluatedTurns) * 1000) / 1000 : null;

    return {
      name: s.name,
      version: s.version,
      status: s.status,
      scope: s.scope,
      ...(s.workspacePath ? { workspacePath: s.workspacePath } : {}),
      ...(s.workspacePath
        ? { workspaceDisplay: sanitizeSkillText(maskHomeDir(s.workspacePath, this.homeDir), 200, this.homeDir) }
        : {}),
      description: sanitizeSkillText(s.description, 1_024, this.homeDir),
      ...(s.whenToUse ? { whenToUse: sanitizeSkillText(s.whenToUse, 500, this.homeDir) } : {}),
      markdown: s.markdown,
      topicKey: s.topicKey,
      evidenceIds: [...s.evidenceIds],
      approvedAt: s.approvedAt,
      updatedAt: s.updatedAt,
      invocationCount: s.invocationCount,
      lastInvokedAt: s.lastInvokedAt,
      evaluatedTurns: s.evaluatedTurns,
      completedTurns: s.completedTurns,
      turnCompletionRate,
      stale,
      daysSinceLastUse,
      exportedWorkspaces: [...s.exportedWorkspaces],
    };
  }

  toArchivedView(a: StoredArchivedSkillRecord): ArchivedSkillViewItem {
    const turnCompletionRate =
      a.evaluatedTurns > 0 ? Math.round((a.completedTurns / a.evaluatedTurns) * 1000) / 1000 : null;
    return {
      name: a.name,
      version: a.version,
      scope: a.scope,
      ...(a.workspacePath ? { workspacePath: a.workspacePath } : {}),
      ...(a.workspacePath
        ? { workspaceDisplay: sanitizeSkillText(maskHomeDir(a.workspacePath, this.homeDir), 200, this.homeDir) }
        : {}),
      description: sanitizeSkillText(a.description, 1_024, this.homeDir),
      ...(a.whenToUse ? { whenToUse: sanitizeSkillText(a.whenToUse, 500, this.homeDir) } : {}),
      markdown: a.markdown,
      topicKey: a.topicKey,
      approvedAt: a.approvedAt,
      archivedAt: a.archivedAt,
      invocationCount: a.invocationCount,
      lastInvokedAt: a.lastInvokedAt,
      turnCompletionRate,
    };
  }
}
