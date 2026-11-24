/**
 * Read-Only Cross-Repository Identity & Structural Profiler (`asi-dream`).
 *
 * - Normalizes multiple Git sibling worktrees (`.git` file + `commondir`) into a
 *   single canonical `repoKey` so sibling worktrees of the same repository never
 *   produce false "cross-repo" insights.
 * - Strictly read-only, bounded size, `lstat` symlink-safe, and skips all source
 *   code files, secrets, `.env*`, credentials, and internal ASI directories.
 * - Extracts only structural stack tags, dependency motifs, script capabilities,
 *   and sanitized `AGENTS.md` / `README.md` architectural headings.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';

const MAX_MANIFEST_BYTES = 32_768;
const MAX_DOC_BYTES = 4_096;
const MAX_PARENT_WALK = 6;
const MAX_TOP_ENTRIES = 40;
const MAX_PROFILED_WORKSPACES = 24;

const INTERNAL_DIR_SEGMENT_RE =
  /(?:^|[\\/])(?:asi-(?:sense|needs|sleep|care|growth|dream)(?:[\\/]|$)|data[\\/]asi(?:[\\/]|$)|\.dsh[\\/]data[\\/]asi)/i;

const SENSITIVE_ENTRY_RE =
  /^(?:\.env(?:\..+)?|\.?secrets?|credentials?(?:\..+)?|.*\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|ed25519|ecdsa))$/i;

const IGNORED_TOP_ENTRIES = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

export interface CanonicalRepoIdentity {
  /** Stable canonical identifier unifying sibling Git worktrees of the same repository. */
  repoKey: string;
  /** Canonical root directory on disk (main worktree root when resolvable). */
  canonicalRoot: string;
  /** Human-friendly short repository name (e.g. `asi`). */
  repoName: string;
  /** Home-masked display path (e.g. `~/work/asi`). */
  displayPath: string;
}

export interface RepoStructuralProfile extends CanonicalRepoIdentity {
  /** All observed workspace / session `cwd` paths belonging to this canonical repo. */
  worktreePaths: string[];
  /** Normalized technology stack & architectural capability tags. */
  stackTags: string[];
  /** Normalized mechanism surfaces present in this repo (e.g. `concurrency-lock`, `module-bundling`). */
  mechanismHints: string[];
  /** Non-sensitive top-level entry names (`packages`, `Cargo.toml`, etc.). */
  topEntries: string[];
  /** Package script keys (`check`, `test`, `e2e`, `build`, etc.). */
  scriptKeys: string[];
  /** Sanitized structural headings / bullet conventions from `AGENTS.md` or `README.md`. */
  conventions: string[];
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

export function isSameOrInsidePath(candidate: string, root: string | undefined): boolean {
  if (!root || !root.trim()) return false;
  const normCand = safeRealpath(candidate);
  const normRoot = safeRealpath(root);
  if (normCand === normRoot) return true;
  const rel = relative(normRoot, normCand);
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function isExcludedDreamPath(
  candidate: string | undefined,
  excludedRoots: readonly (string | undefined)[] = [],
): boolean {
  if (!candidate || !candidate.trim()) return true;
  if (INTERNAL_DIR_SEGMENT_RE.test(candidate)) return true;
  return excludedRoots.some((root) => isSameOrInsidePath(candidate, root));
}

export function maskDreamHomePath(text: string, homeDir?: string): string {
  if (!text) return '';
  let out = text;
  const cleanHome = homeDir?.trim().replace(/[\\/]+$/, '');
  if (cleanHome && cleanHome.length > 1) {
    const escaped = cleanHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?=[\\\\/]|$)`, 'g'), '~');
  }
  return out;
}

export function sanitizeDreamText(raw: string, maxCodePoints = 320, homeDir?: string): string {
  const masked = maskDreamHomePath(String(raw ?? ''), homeDir);
  const redacted = sanitizeForModel(masked).replace(/\s+/g, ' ').trim();
  const cps = [...redacted];
  if (cps.length <= maxCodePoints) return redacted;
  return `${cps.slice(0, Math.max(1, maxCodePoints - 1)).join('')}…`;
}

async function readRegularFileBounded(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const st = await lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > maxBytes) {
      return undefined;
    }
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Resolve a workspace or session `cwd` to its canonical Git repository root,
 * unifying linked Git worktrees via `.git` `gitdir:` + `commondir` pointers.
 */
export async function resolveCanonicalRepoIdentity(
  rawPath: string,
  homeDir?: string,
): Promise<CanonicalRepoIdentity | undefined> {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  const startDir = safeRealpath(trimmed);

  let current = startDir;
  let foundRepoRoot: string | undefined;

  for (let depth = 0; depth <= MAX_PARENT_WALK; depth += 1) {
    const dotGit = join(current, '.git');
    try {
      const st = await lstat(dotGit);
      if (!st.isSymbolicLink()) {
        if (st.isDirectory()) {
          foundRepoRoot = current;
          break;
        }
        if (st.isFile() && st.size > 0 && st.size <= 4_096) {
          const content = await readFile(dotGit, 'utf8');
          const gitDirLine = content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.toLowerCase().startsWith('gitdir:'));
          const gitDirPayload = gitDirLine ? gitDirLine.slice('gitdir:'.length).trim() : '';
          if (gitDirPayload) {
            const gitDir = safeRealpath(isAbsolute(gitDirPayload) ? gitDirPayload : resolve(current, gitDirPayload));
            const commonDirFile = join(gitDir, 'commondir');
            const commonRaw = await readRegularFileBounded(commonDirFile, 2_048);
            if (commonRaw?.trim()) {
              const commonDir = safeRealpath(
                isAbsolute(commonRaw.trim()) ? commonRaw.trim() : resolve(gitDir, commonRaw.trim()),
              );
              if (basename(commonDir) === '.git') {
                foundRepoRoot = dirname(commonDir);
              } else {
                foundRepoRoot = commonDir;
              }
            } else {
              const worktreesSeg = `${sep}.git${sep}worktrees${sep}`;
              const wtIdx = gitDir.indexOf(worktreesSeg);
              foundRepoRoot = wtIdx > 0 ? gitDir.slice(0, wtIdx) : current;
            }
            break;
          }
        }
      }
    } catch {
      // `.git` absent at this level; continue walking upward.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const canonicalRoot = safeRealpath(foundRepoRoot ?? startDir);
  const rawName = basename(canonicalRoot) || 'workspace';
  const repoName = sanitizeDreamText(rawName, 48, homeDir) || 'workspace';
  const displayPath = sanitizeDreamText(maskDreamHomePath(canonicalRoot, homeDir), 96, homeDir) || repoName;
  const hash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 10);
  const slug =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';

  return {
    repoKey: `${slug}#${hash}`,
    canonicalRoot,
    repoName,
    displayPath,
  };
}

const STACK_PATTERNS: ReadonlyArray<{ tag: string; re: RegExp }> = [
  { tag: 'typescript', re: /\b(?:typescript|tsx|tsc)\b/i },
  { tag: 'react', re: /\b(?:react|react-dom|next|remix)\b/i },
  { tag: 'vue', re: /\b(?:vue|nuxt|pinia)\b/i },
  { tag: 'pnpm-monorepo', re: /\b(?:pnpm-workspace|pnpm)\b/i },
  { tag: 'vitest', re: /\bvitest\b/i },
  { tag: 'playwright', re: /\b(?:playwright|@playwright\/test)\b/i },
  { tag: 'biome', re: /\b(?:@biomejs\/biome|biome)\b/i },
  { tag: 'eslint', re: /\beslint\b/i },
  { tag: 'esbuild', re: /\besbuild\b/i },
  { tag: 'vite', re: /\bvite\b/i },
  { tag: 'sqlite', re: /\b(?:better-sqlite3|sqlite3|sqlite|libsql|drizzle-orm)\b/i },
  { tag: 'postgres', re: /\b(?:pg|postgres|postgresql|prisma)\b/i },
  { tag: 'cordis-plugin', re: /\b(?:@deepseek-ai\/cordis|cordis)\b/i },
  { tag: 'typert-rpc', re: /\b(?:dsh-typert|typert)\b/i },
  { tag: 'fsrs-memory', re: /\b(?:ts-fsrs|fsrs|minisearch)\b/i },
  { tag: 'swift-native', re: /\b(?:Package\.swift|swift)\b/i },
  { tag: 'rust', re: /\b(?:Cargo\.toml|tokio|serde)\b/i },
  { tag: 'python', re: /\b(?:pyproject\.toml|pytest|fastapi|pydantic)\b/i },
  { tag: 'go', re: /\b(?:go\.mod|goroutine)\b/i },
  { tag: 'zod-schema', re: /\b(?:zod|schemastery)\b/i },
];

export const MECHANISM_PATTERNS: ReadonlyArray<{ mechanism: string; label: string; re: RegExp }> = [
  {
    mechanism: 'concurrency-lock',
    label: '并发锁与原子写入竞争',
    re: /(?:busy_timeout|deadlock|锁表|并发写|竞态|race\s+condition|atomic\s*(?:write|rename)|原子写|\.lock\b|mutex|watermark|水位线)/i,
  },
  {
    mechanism: 'stream-abort-lifecycle',
    label: '流式传输背压与中断清理',
    re: /(?:abortsignal|abortcontroller|sse\b|stream|backpressure|背压|断线重连|抢占中断|listener\s+leak|内存泄漏|timeout)/i,
  },
  {
    mechanism: 'path-symlink-sandbox',
    label: '符号链接越界与脱敏沙盒护栏',
    re: /(?:symlink|isSymbolicLink|lstat|realpath|路径越界|path\s+traversal|sanitizeForModel|凭据脱敏|打码|redaction)/i,
  },
  {
    mechanism: 'cache-freshness-ttl',
    label: '缓存保鲜期与回滞防抖',
    re: /(?:prompt\s*cache|缓存失效|ttl\b|stale\b|失鲜|回滞|hysteresis|debounce|防抖|节流|throttle)/i,
  },
  {
    mechanism: 'bundle-peer-contract',
    label: '构建外部依赖与模块契约对齐',
    re: /(?:peerDependencies|external\b|esbuild|cjs\b|esm\b|typert|exports\b|sourcemap|bundle\b|打包)/i,
  },
  {
    mechanism: 'state-migration-idempotency',
    label: '状态持久化与无损幂等迁移',
    re: /(?:migration|无损迁移|幂等|idempotent|rollback|回滚|schema\s+version|jsonl\b|对账|reconcile)/i,
  },
  {
    mechanism: 'ui-a11y-overflow',
    label: '紧凑视口防溢出与无障碍对比度',
    re: /(?:axe-core|aria-|tablist|水平溢出|overflow-x|320px|color-mix|对比度|contrast)/i,
  },
  {
    mechanism: 'test-determinism-isolation',
    label: '测试确定性与异步资源回收',
    re: /(?:flaky|不稳定测试|fake\s*timers|vitest|playwright|夹具|fixture|句柄泄漏|unhandled)/i,
  },
];

export function extractMechanismSignals(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const item of MECHANISM_PATTERNS) {
    if (item.re.test(text)) {
      hits.push(item.mechanism);
    }
  }
  return hits;
}

export function mechanismLabelOf(mechanism: string): string {
  return MECHANISM_PATTERNS.find((m) => m.mechanism === mechanism)?.label ?? mechanism;
}

function extractStackTagsFromCorpus(corpus: string, topEntries: readonly string[]): string[] {
  const tags = new Set<string>();
  const joined = `${topEntries.join(' ')}\n${corpus}`;
  for (const { tag, re } of STACK_PATTERNS) {
    if (re.test(joined)) tags.add(tag);
  }
  if (topEntries.includes('pnpm-workspace.yaml') || topEntries.includes('packages')) {
    tags.add('monorepo');
  }
  if (topEntries.includes('Cargo.toml')) tags.add('rust');
  if (topEntries.includes('pyproject.toml')) tags.add('python');
  if (topEntries.includes('go.mod')) tags.add('go');
  if (topEntries.includes('Package.swift') || topEntries.includes('native')) tags.add('swift-native');
  return [...tags].sort();
}

function extractDocConventions(markdown: string, homeDir?: string): string[] {
  const out: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,3}\s+/.test(line) || /^-\s+\*\*[^*]+\*\*/.test(line)) {
      const cleaned = sanitizeDreamText(line.replace(/^#{1,3}\s+/, '').replace(/^-\s+/, ''), 110, homeDir);
      if (cleaned.length >= 4 && !cleaned.toLowerCase().includes('[redacted]')) {
        out.push(cleaned);
      }
      if (out.length >= 8) break;
    }
  }
  return out;
}

/**
 * Scan a single canonical repository root for strictly non-code structural metadata.
 */
export async function scanRepoStructuralProfile(
  identity: CanonicalRepoIdentity,
  worktreePaths: readonly string[],
  homeDir?: string,
): Promise<RepoStructuralProfile> {
  const root = identity.canonicalRoot;
  const topEntries: string[] = [];

  try {
    const dirents = await readdir(root, { withFileTypes: true });
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      if (IGNORED_TOP_ENTRIES.has(d.name) || SENSITIVE_ENTRY_RE.test(d.name)) continue;
      if (d.name.startsWith('.') && d.name !== '.editorconfig' && d.name !== '.github') continue;
      topEntries.push(sanitizeDreamText(d.name, 48, homeDir));
      if (topEntries.length >= MAX_TOP_ENTRIES) break;
    }
  } catch {
    // Unreadable directory falls back to empty structural entries.
  }
  topEntries.sort();

  const depNames: string[] = [];
  const scriptKeys: string[] = [];

  const pkgRaw = await readRegularFileBounded(join(root, 'package.json'), MAX_MANIFEST_BYTES);
  if (pkgRaw) {
    try {
      const parsed = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
        scripts?: Record<string, unknown>;
      };
      for (const bucket of [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies]) {
        if (bucket && typeof bucket === 'object') {
          for (const k of Object.keys(bucket)) {
            depNames.push(sanitizeDreamText(k, 64, homeDir));
          }
        }
      }
      if (parsed.scripts && typeof parsed.scripts === 'object') {
        for (const sk of Object.keys(parsed.scripts)) {
          scriptKeys.push(sanitizeDreamText(sk, 40, homeDir));
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  for (const extraManifest of ['Cargo.toml', 'pyproject.toml', 'go.mod', 'biome.json', 'pnpm-workspace.yaml']) {
    if (topEntries.includes(extraManifest)) {
      const text = await readRegularFileBounded(join(root, extraManifest), 8_192);
      if (text) {
        for (const token of text.matchAll(/\b[a-z][a-z0-9_-]{2,32}\b/gi)) {
          if (depNames.length >= 120) break;
          depNames.push(token[0].toLowerCase());
        }
      }
    }
  }

  const conventions: string[] = [];
  for (const docName of ['AGENTS.md', 'README.md']) {
    const docRaw = await readRegularFileBounded(join(root, docName), MAX_DOC_BYTES);
    if (docRaw) {
      for (const item of extractDocConventions(docRaw, homeDir)) {
        if (!conventions.includes(item)) conventions.push(item);
        if (conventions.length >= 10) break;
      }
    }
  }

  const corpus = `${depNames.join(' ')} ${scriptKeys.join(' ')} ${conventions.join(' ')}`;
  const stackTags = extractStackTagsFromCorpus(corpus, topEntries);
  const mechanismHints = extractMechanismSignals(corpus);
  if (topEntries.includes('biome.json') || depNames.some((d) => d.includes('esbuild') || d.includes('typert'))) {
    if (!mechanismHints.includes('bundle-peer-contract')) mechanismHints.push('bundle-peer-contract');
  }
  if (scriptKeys.includes('e2e') || depNames.some((d) => d.includes('playwright') || d.includes('vitest'))) {
    if (!mechanismHints.includes('test-determinism-isolation')) mechanismHints.push('test-determinism-isolation');
  }

  const uniqueWorktrees = [...new Set(worktreePaths.map((p) => safeRealpath(p)).filter(Boolean))].sort();

  return {
    ...identity,
    worktreePaths: uniqueWorktrees,
    stackTags,
    mechanismHints: [...new Set(mechanismHints)].sort(),
    topEntries,
    scriptKeys: [...new Set(scriptKeys)].slice(0, 24),
    conventions,
  };
}

/**
 * Discover and group multiple workspace/session `cwd` paths into canonical repositories,
 * returning both canonical repo profiles and a fast `cwd -> repoKey` lookup map.
 */
export async function collectRepoProfiles(
  workspacePaths: readonly string[],
  options?: {
    homeDir?: string;
    excludedRoots?: readonly (string | undefined)[];
  },
): Promise<{
  profiles: RepoStructuralProfile[];
  cwdToRepoKey: Map<string, string>;
}> {
  const excluded = options?.excludedRoots ?? [];
  const cwdToRepoKey = new Map<string, string>();
  const grouped = new Map<string, { identity: CanonicalRepoIdentity; paths: Set<string> }>();

  const uniqueInputs = [...new Set(workspacePaths.map((p) => p?.trim()).filter((p): p is string => Boolean(p)))].slice(
    0,
    MAX_PROFILED_WORKSPACES * 2,
  );

  for (const rawPath of uniqueInputs) {
    if (isExcludedDreamPath(rawPath, excluded)) continue;
    const identity = await resolveCanonicalRepoIdentity(rawPath, options?.homeDir);
    if (!identity) continue;
    if (isExcludedDreamPath(identity.canonicalRoot, excluded)) continue;

    cwdToRepoKey.set(rawPath, identity.repoKey);
    cwdToRepoKey.set(safeRealpath(rawPath), identity.repoKey);
    cwdToRepoKey.set(identity.canonicalRoot, identity.repoKey);

    let bucket = grouped.get(identity.repoKey);
    if (!bucket) {
      if (grouped.size >= MAX_PROFILED_WORKSPACES) continue;
      bucket = { identity, paths: new Set<string>() };
      grouped.set(identity.repoKey, bucket);
    }
    bucket.paths.add(rawPath);
    bucket.paths.add(identity.canonicalRoot);
  }

  const profiles: RepoStructuralProfile[] = [];
  for (const { identity, paths } of grouped.values()) {
    profiles.push(await scanRepoStructuralProfile(identity, [...paths], options?.homeDir));
  }
  profiles.sort((a, b) => a.repoKey.localeCompare(b.repoKey));

  return { profiles, cwdToRepoKey };
}
