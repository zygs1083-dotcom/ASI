import {
  type ActionMeasurement,
  type ActionOutcomeLedgerEntry,
  BodySection,
  formatAge,
  formatBytes,
  formatClock,
  formatPercentValue,
  type HelpActionKind,
  type MaintenanceActor,
  type MaintenanceOutcome,
  type ModelConnectivity,
  NEED_KEYS,
  NEED_LABEL,
  type NeedKey,
  type NeedZone,
  NowSection,
  useFreshModel,
} from '@asi/sense-ui';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { computeLineDiff } from '../growth/shared/diff.ts';
import { parseSkillMarkdown } from '../growth/shared/skill-spec.ts';
import type {
  ArchivedSkillViewItem,
  GrowthSynthesisRecord,
  SkillCreateDraftInput,
  SkillDraftViewItem,
  SkillExportResult,
  SkillScope,
  SkillScopeUpdateInput,
  SkillTabView,
  SkillUpdateMarkdownInput,
  SkillViewItem,
} from '../growth/shared/types.ts';
import type { AsiPanelModel } from '../host/dsh/wire-types.ts';
import {
  type FlashbackFeedback,
  type FlashbackMatch,
  PROSPECTIVE_EVENT_KINDS,
  PROSPECTIVE_EVENT_LABELS,
  PROSPECTIVE_TRIGGER_KINDS,
  PROSPECTIVE_TRIGGER_LABELS,
  type ProspectiveCreateInput,
  type ProspectiveEventKind,
  type ProspectiveIntention,
  type ProspectivePriority,
  type ProspectiveResolveInput,
  type ProspectiveStatus,
  type ProspectiveTriggerKind,
} from '../intuition/shared/types.ts';
import { searchMemoryItems } from '../sleep/shared/search.ts';
import {
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryCreateInput,
  type MemoryKind,
  type MemoryUpdateInput,
  type MemoryViewItem,
  type SleepConsolidationRecord,
} from '../sleep/shared/types.ts';
import css from './asi-panel.module.css';

export type AsiMainTab = 'care' | 'memory' | 'skills';

export interface AsiPanelActions {
  // L0/L1/L3 Homeostasis & Care
  onPause: (paused: boolean) => void | Promise<void>;
  onToggleTitles: (enabled: boolean) => void | Promise<void>;
  onOpenPermissionSettings: () => void | Promise<void>;
  onApproveHelp: (cardId: string) => void | Promise<void>;
  onDismissHelp: (cardId: string) => void | Promise<void>;
  onOpenMaintenanceSession: () => void | Promise<void>;
  onTriggerCheck: () => void | Promise<void>;

  // L2 Sleep & Memory Vault
  onConsolidateNow: () => Promise<SleepConsolidationRecord | undefined>;
  onToggleAutoSleepPaused: (paused: boolean) => Promise<void>;
  onCreateMemory: (input: MemoryCreateInput) => Promise<MemoryViewItem | undefined>;
  onUpdateMemory: (id: string, patch: MemoryUpdateInput) => Promise<MemoryViewItem | undefined>;
  onTogglePin: (id: string, pinned: boolean) => Promise<MemoryViewItem | undefined>;
  onDeleteMemory: (id: string) => Promise<void>;
  onSearchMemories?: (query: string, kind?: MemoryKind) => Promise<MemoryViewItem[]>;

  // L4 Skill Studio & Growth
  onSynthesizeNow: () => Promise<GrowthSynthesisRecord | undefined>;
  onToggleAutoGrowthPaused: (paused: boolean) => Promise<void>;
  onCreateManualDraft: (input: SkillCreateDraftInput) => Promise<SkillDraftViewItem | undefined>;
  onUpdateDraft: (draftId: string, patch: SkillUpdateMarkdownInput) => Promise<SkillDraftViewItem | undefined>;
  onApproveDraft: (draftId: string) => Promise<SkillViewItem | undefined>;
  onRejectDraft: (draftId: string) => Promise<void>;
  onUpdateSkill: (name: string, patch: SkillUpdateMarkdownInput) => Promise<SkillViewItem | undefined>;
  onSetSkillScope: (name: string, input: SkillScopeUpdateInput) => Promise<SkillViewItem | undefined>;
  onSetSkillEnabled: (name: string, enabled: boolean) => Promise<SkillViewItem | undefined>;
  onArchiveSkill: (name: string) => Promise<ArchivedSkillViewItem | undefined>;
  onRestoreSkill: (name: string) => Promise<SkillViewItem | undefined>;
  onDeleteArchivedSkill: (name: string) => Promise<void>;
  onExportSkillToWorkspace: (name: string, workspacePath: string) => Promise<SkillExportResult | undefined>;

  // Prefrontal Intuition & Prospective Memory
  onToggleAutoIntuitionPaused?: (paused: boolean) => Promise<void>;
  onCreateProspectiveIntention?: (input: ProspectiveCreateInput) => Promise<ProspectiveIntention | undefined>;
  onResolveProspectiveIntention?: (input: ProspectiveResolveInput) => Promise<ProspectiveIntention | undefined>;
  onDeleteProspectiveIntention?: (id: string) => Promise<void>;
  onRecordFlashbackFeedback?: (sourceId: string, feedback: FlashbackFeedback) => Promise<void>;
  onScanIntuitionFlashbacks?: (cueText: string) => Promise<FlashbackMatch[]>;
}

export interface AsiPanelProps extends AsiPanelActions {
  model: AsiPanelModel;
  initialTab?: AsiMainTab;
}

const ZONE_WORD: Record<NeedZone, string> = {
  comfortable: '舒适',
  uncomfortable: '不适',
  critical: '危急',
};

const CAPSULE_ZONE_LABEL: Record<NeedZone, string> = {
  comfortable: '稳态舒适',
  uncomfortable: '存在不适',
  critical: '生存危急',
};

const APPROVE_LABEL: Record<HelpActionKind, string> = {
  acknowledge: '我已处理',
  'clean-cache': '批准清理缓存',
  'clean-external-cache': '批准清理外部缓存',
  'stop-stuck-jobs': '批准结束任务',
  'compact-context': '批准整理上下文',
  'enable-eco': '启用节能模式',
  'open-permissions': '打开权限设置',
  'run-drive-action': '批准执行看护动作',
};

const SESSION_STATUS_TEXT = {
  'not-created': '待命',
  idle: '空闲待命',
  running: '排查自救中',
  unavailable: '不可用',
} as const;

const CONNECTIVITY_TEXT: Record<ModelConnectivity, string> = {
  online: '在线',
  degraded: '不稳定',
  offline: '失联',
};

const ACTOR_TEXT: Record<MaintenanceActor, string> = {
  instinct: '本能反射',
  maintainer: '自维护会话',
  user: '人工批准',
};

const OUTCOME_TEXT: Record<MaintenanceOutcome, string> = {
  relieved: '已缓解',
  partial: '部分缓解',
  escalated: '转人工协助',
  info: '已记录',
  failed: '执行失败',
};

const HIGHER_DRIVE_LABEL: Record<string, string> = {
  'asi-sleep:consolidation': 'L2 睡眠记忆整合',
  'asi-care:repo_hygiene': 'L3 仓库与工作树卫生',
  'asi-care:orphan_runtime': 'L3 僵尸进程与孤儿端口',
  'asi-care:workspace_bloat': 'L3 闲置工作树产物膨胀',
  'asi-intuition:prospective_sentinel': 'L3 前额叶直觉与前瞻',
  'asi-growth:skill_synthesis': 'L4 技能提炼与自进化',
};

const PROSPECTIVE_STATUS_LABEL: Record<ProspectiveStatus, string> = {
  surfaced: '已触发待办',
  pending: '守候中',
  snoozed: '已延后',
  fulfilled: '已完成',
  canceled: '已取消',
  expired: '已过期',
};

const MAIN_TABS: readonly AsiMainTab[] = ['care', 'memory', 'skills'];

function ShieldIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 2.8 3.8v4.1c0 3.2 2.2 5.9 5.2 6.6 3-0.7 5.2-3.4 5.2-6.6V3.8L8 1.6Z"
        stroke="currentColor"
        strokeWidth={1.35}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
      <circle cx={5.5} cy={4.5} r={1.5} fill="var(--asi-surface, #fff)" stroke="currentColor" strokeWidth={1.2} />
      <circle cx={10.5} cy={8} r={1.5} fill="var(--asi-surface, #fff)" stroke="currentColor" strokeWidth={1.2} />
      <circle cx={6.5} cy={11.5} r={1.5} fill="var(--asi-surface, #fff)" stroke="currentColor" strokeWidth={1.2} />
    </svg>
  );
}

function formatRelativeAgo(targetAt: number | null, now: number): string {
  if (targetAt === null || !Number.isFinite(targetAt)) return '尚未执行';
  const diffMs = Math.max(0, now - targetAt);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

function encodeScopeSelectValue(scope: SkillScope, workspacePath?: string): string {
  return scope === 'workspace' && workspacePath ? `ws:${workspacePath}` : 'global';
}

function formatNeedKeyLabel(key: string): string {
  return NEED_LABEL[key as NeedKey] ?? HIGHER_DRIVE_LABEL[key] ?? key;
}

function formatGainSummary(gain?: ActionMeasurement): string | undefined {
  if (!gain) return undefined;
  const parts: string[] = [];
  if (gain.freedBytes && gain.freedBytes > 0) parts.push(`释放 ${formatBytes(gain.freedBytes)}`);
  if (gain.stoppedJobs && gain.stoppedJobs > 0) parts.push(`结束 ${gain.stoppedJobs} 任务`);
  if (gain.tokensSaved && gain.tokensSaved > 0) parts.push(`省 ${gain.tokensSaved} tokens`);
  if (gain.satisfactionDelta !== undefined && gain.satisfactionDelta !== 0) {
    const sign = gain.satisfactionDelta > 0 ? '+' : '';
    parts.push(`满足度 ${sign}${gain.satisfactionDelta}%`);
  }
  if (parts.length === 0) return gain.effective ? '实测有效' : '零收益';
  return parts.join(' · ');
}

function formatLedgerCumulativeGain(entry: ActionOutcomeLedgerEntry): string {
  const parts: string[] = [];
  if (entry.totalFreedBytes > 0) parts.push(`累计释放 ${formatBytes(entry.totalFreedBytes)}`);
  if (entry.totalStoppedJobs > 0) parts.push(`累计结束 ${entry.totalStoppedJobs} 任务`);
  if (entry.totalTokensSaved > 0) parts.push(`累计省 ${entry.totalTokensSaved} tokens`);
  if (entry.totalSatisfactionDelta > 0) parts.push(`累计 +${entry.totalSatisfactionDelta}%`);
  return parts.length > 0 ? parts.join(' · ') : '尚无净收益';
}

export function AsiPanel(props: AsiPanelProps) {
  const needsModel = useFreshModel(props.model.needs);
  const sleepModel = props.model.sleep;
  const growthModel = props.model.growth;
  const intuitionModel = props.model.intuition;
  const isStale = Boolean(sleepModel.stale || growthModel.stale || intuitionModel.stale);

  // ---- Global Navigation & Settings State ----
  const [activeTab, setActiveTab] = useState<AsiMainTab>(props.initialTab ?? 'care');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [spotlightFeedback, setSpotlightFeedback] = useState<string | null>(null);
  const [spotlightIsError, setSpotlightIsError] = useState(false);
  const [spotlightBusy, setSpotlightBusy] = useState(false);

  // ---- Tab 1 (稳态看护) State ----
  const [careBusyId, setCareBusyId] = useState<string | null>(null);
  const [careFeedback, setCareFeedback] = useState<string | null>(null);
  const [maintBusy, setMaintBusy] = useState(false);

  // ---- Tab 2 (记忆库 & 直觉前瞻) State ----
  const [memorySubTab, setMemorySubTab] = useState<'vault' | 'intuition'>('vault');
  const [prospectiveFilter, setProspectiveFilter] = useState<'active' | 'history'>('active');
  const [creatingProspective, setCreatingProspective] = useState(false);
  const [pmTitle, setPmTitle] = useState('');
  const [pmInstruction, setPmInstruction] = useState('');
  const [pmTriggerKind, setPmTriggerKind] = useState<ProspectiveTriggerKind>('context');
  const [pmPriority, setPmPriority] = useState<ProspectivePriority>('normal');
  const [pmDelayMins, setPmDelayMins] = useState('30');
  const [pmWorkspaceMatch, setPmWorkspaceMatch] = useState('');
  const [pmKeywordMatch, setPmKeywordMatch] = useState('');
  const [pmEventKind, setPmEventKind] = useState<ProspectiveEventKind>('next_session');
  const [pmTargetPattern, setPmTargetPattern] = useState('');
  const [scanCueInput, setScanCueInput] = useState('');
  const [scanHits, setScanHits] = useState<FlashbackMatch[] | null>(null);
  const [intuitionFeedback, setIntuitionFeedback] = useState<string | null>(null);
  const [intuitionIsError, setIntuitionIsError] = useState(false);

  const [memQuery, setMemQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<MemoryKind | 'all'>('all');
  const [creatingMemory, setCreatingMemory] = useState(false);
  const [createKind, setCreateKind] = useState<MemoryKind>('preference');
  const [createTitle, setCreateTitle] = useState('');
  const [createContent, setCreateContent] = useState('');
  const [createTags, setCreateTags] = useState('');
  const [createPinned, setCreatePinned] = useState(false);

  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<MemoryKind>('preference');
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editPinned, setEditPinned] = useState(false);
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Record<string, boolean>>({});

  const [busyConsolidate, setBusyConsolidate] = useState(false);
  const [sleepFeedback, setSleepFeedback] = useState<string | null>(null);
  const [remoteSearchResults, setRemoteSearchResults] = useState<MemoryViewItem[] | null>(null);
  const [vaultMutationSeq, setVaultMutationSeq] = useState(0);

  // ---- Tab 3 (技能工坊) State ----
  const [skillSubTab, setSkillSubTab] = useState<SkillTabView>(() =>
    growthModel.draftCount > 0 ? 'drafts' : 'active',
  );
  const prevDraftCountRef = useRef(growthModel.draftCount);
  const [skillQuery, setSkillQuery] = useState('');
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [createSkillName, setCreateSkillName] = useState('');
  const [createSkillDesc, setCreateSkillDesc] = useState('');
  const [createSkillWhen, setCreateSkillWhen] = useState('');
  const [createSkillScope, setCreateSkillScope] = useState<SkillScope>('global');
  const [createSkillWorkspace, setCreateSkillWorkspace] = useState(() => growthModel.knownWorkspaces[0]?.path ?? '');
  const [createSkillBody, setCreateSkillBody] = useState('');

  const [openPreviewId, setOpenPreviewId] = useState<string | null>(null);
  const [editingSkillKey, setEditingSkillKey] = useState<string | null>(null);
  const [editMarkdown, setEditMarkdown] = useState('');
  const [openDiffDraftId, setOpenDiffDraftId] = useState<string | null>(null);
  const [exportTargetBySkill, setExportTargetBySkill] = useState<Record<string, string>>({});
  const [customExportPathBySkill, setCustomExportPathBySkill] = useState<Record<string, string>>({});
  const [customScopeInputByKey, setCustomScopeInputByKey] = useState<Record<string, string>>({});

  const [busySynthesize, setBusySynthesize] = useState(false);
  const [growthFeedback, setGrowthFeedback] = useState<string | null>(null);

  // ---- Derived Homeostasis & Cross-Tab Counts ----
  const openHelpCards = useMemo(() => needsModel.helpCards.filter((c) => c.status === 'open'), [needsModel.helpCards]);
  const activeL1Drives = useMemo(() => NEED_KEYS.filter((k) => needsModel.needs[k].driveActive), [needsModel.needs]);
  const capsuleZone: NeedZone =
    needsModel.overallZone === 'comfortable' && activeL1Drives.length > 0 ? 'uncomfortable' : needsModel.overallZone;
  const capsuleText =
    needsModel.overallZone === 'comfortable' && activeL1Drives.length > 0
      ? '恢复保持'
      : CAPSULE_ZONE_LABEL[needsModel.overallZone];

  // ---- Memory Search & Filtering ----
  const hasOverflowVault = sleepModel.totalMemories > sleepModel.memories.length;
  const onSearchMemories = props.onSearchMemories;
  const headMem = sleepModel.memories[0];
  const vaultSearchWatermark = `${sleepModel.totalMemories}:${headMem?.id ?? ''}:${headMem?.updatedAt ?? 0}:${headMem?.pinned ? 1 : 0}:${vaultMutationSeq}`;

  useEffect(() => {
    if (!hasOverflowVault || !onSearchMemories || (!memQuery.trim() && kindFilter === 'all')) {
      setRemoteSearchResults(null);
      return;
    }
    const activeWatermark = vaultSearchWatermark;
    let cancelled = false;
    void onSearchMemories(memQuery, kindFilter === 'all' ? undefined : kindFilter)
      .then((items) => {
        if (!cancelled && activeWatermark) setRemoteSearchResults(items);
      })
      .catch(() => {
        if (!cancelled) setRemoteSearchResults(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasOverflowVault, onSearchMemories, memQuery, kindFilter, vaultSearchWatermark]);

  useEffect(() => {
    if (prevDraftCountRef.current === 0 && growthModel.draftCount > 0) {
      setSkillSubTab('drafts');
    }
    prevDraftCountRef.current = growthModel.draftCount;
  }, [growthModel.draftCount]);

  const firstKnownWorkspacePath = growthModel.knownWorkspaces[0]?.path ?? '';
  useEffect(() => {
    if (!createSkillWorkspace && firstKnownWorkspacePath) {
      setCreateSkillWorkspace(firstKnownWorkspacePath);
    }
  }, [createSkillWorkspace, firstKnownWorkspacePath]);

  const filteredMemories = useMemo(() => {
    if (remoteSearchResults !== null) return remoteSearchResults;
    return searchMemoryItems(sleepModel.memories, memQuery, {
      ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
      includeLowRetention: true,
      limit: 500,
    });
  }, [sleepModel.memories, memQuery, kindFilter, remoteSearchResults]);

  // ---- Skill Search & Validation ----
  const normSkillQuery = skillQuery.trim().toLowerCase();
  const filteredDrafts = useMemo(() => {
    if (!normSkillQuery) return growthModel.drafts;
    return growthModel.drafts.filter(
      (d) =>
        d.name.toLowerCase().includes(normSkillQuery) ||
        d.description.toLowerCase().includes(normSkillQuery) ||
        d.markdown.toLowerCase().includes(normSkillQuery),
    );
  }, [growthModel.drafts, normSkillQuery]);

  const filteredSkills = useMemo(() => {
    if (!normSkillQuery) return growthModel.skills;
    return growthModel.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(normSkillQuery) ||
        s.description.toLowerCase().includes(normSkillQuery) ||
        s.markdown.toLowerCase().includes(normSkillQuery),
    );
  }, [growthModel.skills, normSkillQuery]);

  const filteredArchived = useMemo(() => {
    if (!normSkillQuery) return growthModel.archivedSkills;
    return growthModel.archivedSkills.filter(
      (a) =>
        a.name.toLowerCase().includes(normSkillQuery) ||
        a.description.toLowerCase().includes(normSkillQuery) ||
        a.markdown.toLowerCase().includes(normSkillQuery),
    );
  }, [growthModel.archivedSkills, normSkillQuery]);

  const editValidation = useMemo(() => {
    if (!editingSkillKey) return null;
    return parseSkillMarkdown(editMarkdown);
  }, [editingSkillKey, editMarkdown]);

  const buildWorkspaceOptions = (extraPath?: string, extraDisplay?: string) => {
    const map = new Map<string, string>();
    for (const ws of growthModel.knownWorkspaces) {
      map.set(ws.path, ws.display);
    }
    if (extraPath && !map.has(extraPath)) {
      map.set(extraPath, extraDisplay ?? extraPath);
    }
    return [...map.entries()];
  };

  const selectMainTab = (target: AsiMainTab) => {
    if (target === 'skills' && activeTab !== 'skills' && growthModel.draftCount > 0) {
      setSkillSubTab('drafts');
    }
    setActiveTab(target);
  };

  // ---- Keyboard Tab Switcher ----
  const handleMainTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % MAIN_TABS.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + MAIN_TABS.length) % MAIN_TABS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = MAIN_TABS.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      const target = MAIN_TABS[nextIdx] ?? 'care';
      selectMainTab(target);
      document.getElementById(`asi-tab-${target}`)?.focus();
    }
  };

  // ---- Action Handlers ----
  const handleGlobalPause = async (paused: boolean) => {
    try {
      await props.onPause(paused);
    } catch (err) {
      setSpotlightIsError(true);
      setSpotlightFeedback(err instanceof Error ? err.message : '切换暂停状态失败');
    }
  };

  const handleGlobalTitles = async (enabled: boolean) => {
    try {
      await props.onToggleTitles(enabled);
    } catch (err) {
      setSpotlightIsError(true);
      setSpotlightFeedback(err instanceof Error ? err.message : '更新窗口标题设置失败');
    }
  };

  const handleOpenPermissionSettings = async () => {
    setCareFeedback(null);
    try {
      await props.onOpenPermissionSettings();
    } catch (err) {
      setCareFeedback(err instanceof Error ? err.message : '打开权限设置失败，请稍后重试');
    }
  };

  const handleCareHelpAction = async (
    cardId: string,
    label: string,
    fn: (id: string) => void | Promise<void>,
    fromSpotlight = false,
  ) => {
    if (fromSpotlight) setSpotlightBusy(true);
    setCareBusyId(cardId);
    setCareFeedback(null);
    setSpotlightFeedback(null);
    setSpotlightIsError(false);
    try {
      await fn(cardId);
      if (fromSpotlight) {
        setSpotlightIsError(false);
        setSpotlightFeedback(`已完成：${label}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `${label}失败，请重试`;
      if (fromSpotlight) {
        setSpotlightIsError(true);
        setSpotlightFeedback(msg);
      } else {
        setCareFeedback(msg);
      }
    } finally {
      setCareBusyId(null);
      if (fromSpotlight) setSpotlightBusy(false);
    }
  };

  const handleMaintAction = async (label: string, fn: () => void | Promise<void>) => {
    setMaintBusy(true);
    setCareFeedback(null);
    try {
      await fn();
    } catch (err) {
      setCareFeedback(err instanceof Error ? err.message : `${label}失败，请稍后重试`);
    } finally {
      setMaintBusy(false);
    }
  };

  const handleConsolidateNow = async () => {
    if (busyConsolidate || sleepModel.consolidating) return;
    setBusyConsolidate(true);
    setSleepFeedback(null);
    try {
      const rec = await props.onConsolidateNow();
      setVaultMutationSeq((n) => n + 1);
      setSleepFeedback(rec?.summary || '已完成立即睡眠整合。');
    } catch (err) {
      setSleepFeedback(err instanceof Error ? err.message : '睡眠整合执行失败');
    } finally {
      setBusyConsolidate(false);
    }
  };

  const handleToggleAutoSleepPaused = async (paused: boolean) => {
    try {
      await props.onToggleAutoSleepPaused(paused);
    } catch (err) {
      setSleepFeedback(err instanceof Error ? err.message : '更新自动睡眠设置失败');
    }
  };

  const handleCreateMemorySubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!createTitle.trim() || !createContent.trim()) return;
    try {
      await props.onCreateMemory({
        kind: createKind,
        title: createTitle.trim(),
        content: createContent.trim(),
        tags: parseTagsInput(createTags),
        pinned: createPinned,
      });
      setCreateTitle('');
      setCreateContent('');
      setCreateTags('');
      setCreatePinned(false);
      setCreatingMemory(false);
      setVaultMutationSeq((n) => n + 1);
      setSleepFeedback('已新建记忆条目。');
    } catch (err) {
      setSleepFeedback(err instanceof Error ? err.message : '新建记忆失败');
    }
  };

  const beginEditMemory = (item: MemoryViewItem) => {
    setEditingMemoryId(item.id);
    setEditKind(item.kind);
    setEditTitle(item.title);
    setEditContent(item.content);
    setEditTags(item.tags.join(', '));
    setEditPinned(item.pinned);
  };

  const handleEditMemorySubmit = async (e: FormEvent, id: string) => {
    e.preventDefault();
    if (!editTitle.trim() || !editContent.trim()) return;
    try {
      await props.onUpdateMemory(id, {
        kind: editKind,
        title: editTitle.trim(),
        content: editContent.trim(),
        tags: parseTagsInput(editTags),
        pinned: editPinned,
      });
      setEditingMemoryId(null);
      setVaultMutationSeq((n) => n + 1);
      setSleepFeedback('已保存记忆修改。');
    } catch (err) {
      setSleepFeedback(err instanceof Error ? err.message : '更新记忆失败');
    }
  };

  const handleTogglePin = async (id: string, nextPinned: boolean) => {
    try {
      await props.onTogglePin(id, nextPinned);
      setVaultMutationSeq((n) => n + 1);
    } catch (err) {
      setSleepFeedback(err instanceof Error ? err.message : '更新置顶状态失败');
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      await props.onDeleteMemory(id);
      if (editingMemoryId === id) setEditingMemoryId(null);
      setVaultMutationSeq((n) => n + 1);
    } catch (err) {
      setSleepFeedback(err instanceof Error ? err.message : '删除记忆失败');
    }
  };

  const handleSynthesizeNow = async () => {
    if (busySynthesize || growthModel.synthesizing) return;
    setBusySynthesize(true);
    setGrowthFeedback(null);
    try {
      const rec = await props.onSynthesizeNow();
      setGrowthFeedback(rec?.summary || '已完成技能提炼检查。');
      if (rec && rec.draftsCreated + rec.revisionsCreated > 0) {
        setSkillSubTab('drafts');
      }
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '技能提炼失败');
    } finally {
      setBusySynthesize(false);
    }
  };

  const handleToggleAutoGrowthPaused = async (paused: boolean) => {
    try {
      await props.onToggleAutoGrowthPaused(paused);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '更新自动提炼开关失败');
    }
  };

  const handleCreateSkillSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!createSkillName.trim() || !createSkillDesc.trim() || !createSkillBody.trim()) return;
    try {
      const wsPath =
        createSkillScope === 'workspace'
          ? createSkillWorkspace.trim() || growthModel.knownWorkspaces[0]?.path
          : undefined;
      const created = await props.onCreateManualDraft({
        name: createSkillName.trim(),
        description: createSkillDesc.trim(),
        ...(createSkillWhen.trim() ? { whenToUse: createSkillWhen.trim() } : {}),
        scope: createSkillScope,
        ...(wsPath ? { workspacePath: wsPath } : {}),
        body: createSkillBody.trim(),
      });
      setCreateSkillName('');
      setCreateSkillDesc('');
      setCreateSkillWhen('');
      setCreateSkillBody('');
      setCreatingSkill(false);
      setSkillSubTab('drafts');
      setGrowthFeedback(`已创建待审技能草案 ${created?.name ?? ''}，请审阅后点击批准启用。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '创建技能草案失败');
    }
  };

  const handleApproveDraft = async (draft: SkillDraftViewItem, fromSpotlight = false) => {
    if (fromSpotlight) setSpotlightBusy(true);
    try {
      const approved = await props.onApproveDraft(draft.id);
      const msg = `已批准启用 ${approved?.name ?? draft.name} (v${approved?.version ?? draft.targetVersion}) · 已热挂载至 ctx.skills。`;
      setGrowthFeedback(msg);
      if (fromSpotlight) {
        setSpotlightIsError(false);
        setSpotlightFeedback(msg);
      } else {
        setSkillSubTab('active');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '批准草案失败';
      if (fromSpotlight) {
        setSpotlightIsError(true);
        setSpotlightFeedback(msg);
      } else {
        setGrowthFeedback(msg);
      }
    } finally {
      if (fromSpotlight) setSpotlightBusy(false);
    }
  };

  const handleRejectDraft = async (draft: SkillDraftViewItem) => {
    try {
      await props.onRejectDraft(draft.id);
      setGrowthFeedback(`已驳回草案 ${draft.name}。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '驳回草案失败');
    }
  };

  const beginEditMarkdown = (key: string, markdown: string) => {
    setEditingSkillKey(key);
    setEditMarkdown(markdown);
    setOpenPreviewId(null);
  };

  const handleSaveDraftEdit = async (e: FormEvent, draftId: string) => {
    e.preventDefault();
    const check = parseSkillMarkdown(editMarkdown);
    if (!check.valid) {
      setGrowthFeedback(`SKILL.md 校验未通过：${check.errors[0] ?? '格式错误'}`);
      return;
    }
    try {
      await props.onUpdateDraft(draftId, { markdown: editMarkdown });
      setEditingSkillKey(null);
      setGrowthFeedback('已保存草案 SKILL.md 修改。');
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '保存草案修改失败');
    }
  };

  const handleSaveSkillEdit = async (e: FormEvent, name: string) => {
    e.preventDefault();
    const check = parseSkillMarkdown(editMarkdown);
    if (!check.valid) {
      setGrowthFeedback(`SKILL.md 校验未通过：${check.errors[0] ?? '格式错误'}`);
      return;
    }
    try {
      await props.onUpdateSkill(name, { markdown: editMarkdown });
      setEditingSkillKey(null);
      setGrowthFeedback(`已保存并热重载技能 ${name}。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '保存技能修改失败');
    }
  };

  const handleDraftScopeChange = async (draft: SkillDraftViewItem, selectValue: string) => {
    const scopeKey = `draft:${draft.id}`;
    if (selectValue === '__custom__') {
      setCustomScopeInputByKey((prev) => ({ ...prev, [scopeKey]: draft.workspacePath ?? '' }));
      return;
    }
    setCustomScopeInputByKey((prev) => {
      const next = { ...prev };
      delete next[scopeKey];
      return next;
    });
    try {
      if (selectValue === 'global') {
        await props.onUpdateDraft(draft.id, { markdown: draft.markdown, scope: 'global' });
        setGrowthFeedback(`已将草案 ${draft.name} 切为全局作用域。`);
      } else if (selectValue.startsWith('ws:')) {
        const wsPath = selectValue.slice(3);
        await props.onUpdateDraft(draft.id, { markdown: draft.markdown, scope: 'workspace', workspacePath: wsPath });
        setGrowthFeedback(`已将草案 ${draft.name} 绑定至目标工作区。`);
      }
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '切换草案作用域失败');
    }
  };

  const handleApplyCustomDraftScope = async (draft: SkillDraftViewItem) => {
    const scopeKey = `draft:${draft.id}`;
    const customWs = (customScopeInputByKey[scopeKey] ?? '').trim();
    if (!customWs) {
      setGrowthFeedback('请输入目标工作区绝对路径。');
      return;
    }
    try {
      await props.onUpdateDraft(draft.id, { markdown: draft.markdown, scope: 'workspace', workspacePath: customWs });
      setCustomScopeInputByKey((prev) => {
        const next = { ...prev };
        delete next[scopeKey];
        return next;
      });
      setGrowthFeedback(`已将草案 ${draft.name} 绑定至目标工作区。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '切换草案作用域失败');
    }
  };

  const handleSkillScopeChange = async (skill: SkillViewItem, selectValue: string) => {
    const scopeKey = `skill:${skill.name}`;
    if (selectValue === '__custom__') {
      setCustomScopeInputByKey((prev) => ({ ...prev, [scopeKey]: skill.workspacePath ?? '' }));
      return;
    }
    setCustomScopeInputByKey((prev) => {
      const next = { ...prev };
      delete next[scopeKey];
      return next;
    });
    try {
      if (selectValue === 'global') {
        await props.onSetSkillScope(skill.name, { scope: 'global' });
        setGrowthFeedback(`已将技能 ${skill.name} 切为全局生效并热刷新 ctx.skills。`);
      } else if (selectValue.startsWith('ws:')) {
        const wsPath = selectValue.slice(3);
        await props.onSetSkillScope(skill.name, { scope: 'workspace', workspacePath: wsPath });
        setGrowthFeedback(`已将技能 ${skill.name} 限定至工作区生效并热刷新 ctx.skills。`);
      }
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '切换技能作用域失败');
    }
  };

  const handleApplyCustomSkillScope = async (skill: SkillViewItem) => {
    const scopeKey = `skill:${skill.name}`;
    const customWs = (customScopeInputByKey[scopeKey] ?? '').trim();
    if (!customWs) {
      setGrowthFeedback('请输入目标工作区绝对路径。');
      return;
    }
    try {
      await props.onSetSkillScope(skill.name, { scope: 'workspace', workspacePath: customWs });
      setCustomScopeInputByKey((prev) => {
        const next = { ...prev };
        delete next[scopeKey];
        return next;
      });
      setGrowthFeedback(`已将技能 ${skill.name} 限定至工作区生效并热刷新 ctx.skills。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '切换技能作用域失败');
    }
  };

  const handleToggleSkillEnabled = async (skill: SkillViewItem) => {
    const nextEnabled = skill.status !== 'active';
    try {
      await props.onSetSkillEnabled(skill.name, nextEnabled);
      setGrowthFeedback(
        nextEnabled
          ? `已启用技能 ${skill.name} 并挂载至 ctx.skills。`
          : `已停用技能 ${skill.name}（从 ctx.skills 卸载）。`,
      );
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '切换技能启用状态失败');
    }
  };

  const handleArchiveSkill = async (name: string) => {
    try {
      await props.onArchiveSkill(name);
      setGrowthFeedback(`已归档技能 ${name}（已从 ctx.skills 卸载，可在已归档页一键恢复）。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '归档技能失败');
    }
  };

  const handleRestoreSkill = async (name: string) => {
    try {
      await props.onRestoreSkill(name);
      setGrowthFeedback(`已恢复启用技能 ${name} 并重新挂载至 ctx.skills。`);
      setSkillSubTab('active');
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '恢复技能失败');
    }
  };

  const handleDeleteArchived = async (name: string) => {
    try {
      await props.onDeleteArchivedSkill(name);
      setGrowthFeedback(`已删除归档技能 ${name}。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '删除归档失败');
    }
  };

  const handleExportSkill = async (skill: SkillViewItem, hasWsDropdown: boolean) => {
    const rawSelect = exportTargetBySkill[skill.name];
    const selectedWs = !hasWsDropdown
      ? (customExportPathBySkill[skill.name] ?? '')
      : rawSelect === '__custom__'
        ? (customExportPathBySkill[skill.name] ?? '')
        : (rawSelect ?? skill.workspacePath ?? growthModel.knownWorkspaces[0]?.path ?? '');
    if (!selectedWs.trim()) {
      setGrowthFeedback('请先选择或输入要导出的目标工作区路径。');
      return;
    }
    try {
      const res = await props.onExportSkillToWorkspace(skill.name, selectedWs.trim());
      setGrowthFeedback(`已导出至 ${res?.displayPath ?? '.agents/skills'}。`);
    } catch (err) {
      setGrowthFeedback(err instanceof Error ? err.message : '导出技能至工作区失败');
    }
  };

  // ---- Cross-Tab Spotlight Items ----
  const surfacedIntentions = useMemo(
    () => intuitionModel.intentions.filter((i) => i.status === 'surfaced'),
    [intuitionModel.intentions],
  );
  const activeIntentions = useMemo(
    () =>
      intuitionModel.intentions.filter(
        (i) => i.status === 'surfaced' || i.status === 'pending' || i.status === 'snoozed',
      ),
    [intuitionModel.intentions],
  );
  const historyIntentions = useMemo(
    () =>
      intuitionModel.intentions.filter(
        (i) => i.status === 'fulfilled' || i.status === 'canceled' || i.status === 'expired',
      ),
    [intuitionModel.intentions],
  );

  const handleToggleAutoIntuition = async (paused: boolean) => {
    if (!props.onToggleAutoIntuitionPaused) return;
    setIntuitionFeedback(null);
    setIntuitionIsError(false);
    try {
      await props.onToggleAutoIntuitionPaused(paused);
    } catch (err) {
      setIntuitionIsError(true);
      setIntuitionFeedback(err instanceof Error ? err.message : '切换直觉入队状态失败');
    }
  };

  const handleCreateProspectiveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!props.onCreateProspectiveIntention || !pmTitle.trim() || !pmInstruction.trim()) return;
    setIntuitionFeedback(null);
    setIntuitionIsError(false);
    try {
      const delayNum = Number(pmDelayMins);
      const created = await props.onCreateProspectiveIntention({
        title: pmTitle.trim(),
        instruction: pmInstruction.trim(),
        triggerKind: pmTriggerKind,
        priority: pmPriority,
        ...(pmTriggerKind === 'time'
          ? { delayMinutes: Number.isFinite(delayNum) && delayNum > 0 ? delayNum : 30 }
          : {}),
        ...(pmTriggerKind === 'context' && pmWorkspaceMatch.trim() ? { workspaceMatch: pmWorkspaceMatch.trim() } : {}),
        ...(pmTriggerKind === 'context' && pmKeywordMatch.trim() ? { keywordMatch: pmKeywordMatch.trim() } : {}),
        ...(pmTriggerKind === 'event' ? { eventKind: pmEventKind } : {}),
        ...(pmTriggerKind === 'event' && pmTargetPattern.trim() ? { targetPattern: pmTargetPattern.trim() } : {}),
      });
      setPmTitle('');
      setPmInstruction('');
      setPmWorkspaceMatch('');
      setPmKeywordMatch('');
      setPmTargetPattern('');
      setCreatingProspective(false);
      setProspectiveFilter('active');
      if (created) {
        setIntuitionFeedback(`已登记前瞻提醒「${created.title}」`);
      }
    } catch (err) {
      setIntuitionIsError(true);
      setIntuitionFeedback(err instanceof Error ? err.message : '新建前瞻提醒失败');
    }
  };

  const handleResolveProspective = async (input: ProspectiveResolveInput, fromSpotlight = false) => {
    if (!props.onResolveProspectiveIntention) return;
    if (fromSpotlight) setSpotlightBusy(true);
    setIntuitionFeedback(null);
    setIntuitionIsError(false);
    setSpotlightFeedback(null);
    setSpotlightIsError(false);
    try {
      const res = await props.onResolveProspectiveIntention(input);
      const actionWord =
        input.action === 'fulfill' ? '已完成前瞻提醒' : input.action === 'snooze' ? '已延后提醒' : '已取消提醒';
      if (fromSpotlight) {
        setSpotlightFeedback(`${actionWord}：${res?.title ?? input.id}`);
      } else {
        setIntuitionFeedback(`${actionWord}：${res?.title ?? input.id}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '更新前瞻提醒失败';
      if (fromSpotlight) {
        setSpotlightIsError(true);
        setSpotlightFeedback(msg);
      } else {
        setIntuitionIsError(true);
        setIntuitionFeedback(msg);
      }
    } finally {
      if (fromSpotlight) setSpotlightBusy(false);
    }
  };

  const handleDeleteProspective = async (id: string) => {
    if (!props.onDeleteProspectiveIntention) return;
    setIntuitionFeedback(null);
    setIntuitionIsError(false);
    try {
      await props.onDeleteProspectiveIntention(id);
      setIntuitionFeedback('已移除前瞻历史记录。');
    } catch (err) {
      setIntuitionIsError(true);
      setIntuitionFeedback(err instanceof Error ? err.message : '删除前瞻记录失败');
    }
  };

  const handleFlashbackFeedback = async (sourceId: string, feedback: FlashbackFeedback) => {
    if (!props.onRecordFlashbackFeedback) return;
    setIntuitionFeedback(null);
    setIntuitionIsError(false);
    try {
      await props.onRecordFlashbackFeedback(sourceId, feedback);
      const word = feedback === 'helpful' ? '已标记有帮助' : feedback === 'dismissed' ? '已降权该闪回' : '已静默该来源';
      setIntuitionFeedback(`${word}（${sourceId}）`);
    } catch (err) {
      setIntuitionIsError(true);
      setIntuitionFeedback(err instanceof Error ? err.message : '记录闪回反馈失败');
    }
  };

  const handleScanFlashbacksSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!scanCueInput.trim()) {
      setScanHits(null);
      return;
    }
    if (!props.onScanIntuitionFlashbacks) return;
    setIntuitionFeedback(null);
    setIntuitionIsError(false);
    try {
      const hits = await props.onScanIntuitionFlashbacks(scanCueInput.trim());
      setScanHits(hits);
    } catch (err) {
      setIntuitionIsError(true);
      setIntuitionFeedback(err instanceof Error ? err.message : '直觉风险嗅探失败');
    }
  };

  const topCrossHelp = activeTab !== 'care' ? openHelpCards[0] : undefined;
  const topCrossDraft = activeTab !== 'skills' || skillSubTab !== 'drafts' ? growthModel.drafts[0] : undefined;
  const topCrossProspective =
    activeTab !== 'memory' || memorySubTab !== 'intuition' ? surfacedIntentions[0] : undefined;
  const showSpotlight = Boolean(topCrossHelp || topCrossDraft || topCrossProspective || spotlightFeedback);

  // ---- Sleep & Growth Compact Status Strings ----
  const sleepIdleMins = Math.floor(sleepModel.drive.idleDurationMs / 60_000);
  const sleepQuietText = sleepModel.drive.screenLocked
    ? '已锁屏'
    : sleepModel.drive.quietWindow
      ? `空闲 ${sleepIdleMins}m（就绪）`
      : `空闲 ${sleepIdleMins}/10m`;

  const growthIdleMins = Math.floor(growthModel.drive.idleDurationMs / 60_000);
  const growthQuietText = growthModel.drive.screenLocked
    ? '已锁屏'
    : growthModel.drive.deepQuietWindow
      ? `空闲 ${growthIdleMins}m（就绪）`
      : `空闲 ${growthIdleMins}/20m`;

  const extraDrives = needsModel.higherOrderDrives ?? [];

  return (
    <div className={`${css.asiPanel} ${isStale ? css.stalePanel : ''}`} data-panel data-testid="asi-unified-panel">
      {/* 1. Top Global Status Capsule */}
      <header className={css.topCapsule} data-testid="global-status-capsule">
        <div className={css.capsuleLeft}>
          <h1 className={css.brandTitle}>ASI</h1>
          <span className={css.zonePill} data-zone={capsuleZone} data-testid="global-zone-pill">
            <i className={css.statusDot} aria-hidden="true" />
            {capsuleText}
          </span>
        </div>
        <div className={css.capsuleRight}>
          {needsModel.instinct.powerMode === 'eco' && <span className={`${css.metaChip} ${css.warnChip}`}>节能</span>}
          {needsModel.paused && <span className={`${css.metaChip} ${css.warnChip}`}>已暂停</span>}
          <span className={css.metaChip} title="观察、记忆与技能数据经脱敏仅留在本机">
            <ShieldIcon />
            仅本机
          </span>
          <button
            type="button"
            className={`${css.iconBtn} ${settingsOpen ? css.iconBtnActive : ''}`}
            data-testid="quick-settings-btn"
            aria-label="全局控制与隐私设置"
            aria-expanded={settingsOpen}
            aria-controls="asi-quick-settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <SlidersIcon />
            设置
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section
          id="asi-quick-settings"
          className={css.settingsPopover}
          data-testid="quick-settings-popover"
          aria-label="全局控制与隐私"
        >
          <div className={css.settingsHead}>
            <span>控制与隐私护栏</span>
            <button type="button" className={css.textBtn} onClick={() => setSettingsOpen(false)}>
              收起
            </button>
          </div>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              data-testid="global-pause-toggle"
              checked={needsModel.paused}
              onChange={(e) => void handleGlobalPause(e.currentTarget.checked)}
            />
            暂停感知与自维护
          </label>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              data-testid="global-titles-toggle"
              checked={needsModel.sendTitles}
              onChange={(e) => void handleGlobalTitles(e.currentTarget.checked)}
            />
            窗口标题发给模型
          </label>
          <p className={css.mutedText}>
            日常对话仅按需开放只读工具（零动态提示词注入，保护 Prompt Cache）；全链路经 sanitizeForModel 脱敏。
          </p>
        </section>
      )}

      {/* 2. Segmented 3-Tab Switcher */}
      <div className={css.tabList} role="tablist" aria-label="ASI 功能分区">
        <button
          type="button"
          role="tab"
          id="asi-tab-care"
          data-testid="asi-main-tab-care"
          aria-selected={activeTab === 'care'}
          aria-controls="asi-tabpanel-care"
          tabIndex={activeTab === 'care' ? 0 : -1}
          className={`${css.tabBtn} ${activeTab === 'care' ? css.tabBtnActive : ''}`}
          onClick={() => selectMainTab('care')}
          onKeyDown={(e) => handleMainTabKeyDown(e, 0)}
        >
          <span>稳态看护</span>
          {openHelpCards.length > 0 && (
            <span className={`${css.tabBadge} ${css.tabBadgeAlert}`}>{openHelpCards.length}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          id="asi-tab-memory"
          data-testid="asi-main-tab-memory"
          aria-selected={activeTab === 'memory'}
          aria-controls="asi-tabpanel-memory"
          tabIndex={activeTab === 'memory' ? 0 : -1}
          className={`${css.tabBtn} ${activeTab === 'memory' ? css.tabBtnActive : ''}`}
          onClick={() => selectMainTab('memory')}
          onKeyDown={(e) => handleMainTabKeyDown(e, 1)}
        >
          <span>记忆库</span>
          {sleepModel.totalMemories > 0 && <span className={css.tabBadge}>{sleepModel.totalMemories}</span>}
        </button>

        <button
          type="button"
          role="tab"
          id="asi-tab-skills"
          data-testid="asi-main-tab-skills"
          aria-selected={activeTab === 'skills'}
          aria-controls="asi-tabpanel-skills"
          tabIndex={activeTab === 'skills' ? 0 : -1}
          className={`${css.tabBtn} ${activeTab === 'skills' ? css.tabBtnActive : ''}`}
          onClick={() => selectMainTab('skills')}
          onKeyDown={(e) => handleMainTabKeyDown(e, 2)}
        >
          <span>技能工坊</span>
          {growthModel.draftCount > 0 ? (
            <span className={`${css.tabBadge} ${css.tabBadgeAlert}`}>{growthModel.draftCount}</span>
          ) : growthModel.activeCount > 0 ? (
            <span className={css.tabBadge}>{growthModel.activeCount}</span>
          ) : null}
        </button>
      </div>

      {/* 3. Cross-Tab Pending Spotlight Strip */}
      {showSpotlight && (
        <section className={css.spotlightStrip} data-testid="cross-tab-spotlight" aria-label="跨页待处理事项">
          {spotlightFeedback && (
            <div
              role={spotlightIsError ? 'alert' : 'status'}
              className={spotlightIsError ? css.alertBanner : css.feedbackBanner}
              data-testid="spotlight-feedback"
            >
              <span>{spotlightFeedback}</span>
              <button
                type="button"
                className={css.textBtn}
                onClick={() => {
                  setSpotlightFeedback(null);
                  setSpotlightIsError(false);
                }}
              >
                关闭
              </button>
            </div>
          )}

          {topCrossHelp && (
            <div
              className={css.spotlightItem}
              data-tone={topCrossHelp.severity === 'critical' ? 'critical' : 'warn'}
              data-testid="spotlight-help-banner"
            >
              <div className={css.spotlightBody}>
                <div>
                  <div className={css.spotlightTitle}>
                    待处理求助 ({openHelpCards.length})：{topCrossHelp.title}
                  </div>
                  <div className={css.spotlightSub}>{topCrossHelp.summary}</div>
                </div>
              </div>
              <div className={css.actionRow}>
                <button
                  type="button"
                  className={css.primaryBtn}
                  data-testid="spotlight-approve-help"
                  disabled={spotlightBusy}
                  onClick={() =>
                    void handleCareHelpAction(
                      topCrossHelp.id,
                      topCrossHelp.approveLabel || APPROVE_LABEL[topCrossHelp.actionKind],
                      props.onApproveHelp,
                      true,
                    )
                  }
                >
                  {topCrossHelp.approveLabel || APPROVE_LABEL[topCrossHelp.actionKind]}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  data-testid="spotlight-jump-care"
                  onClick={() => setActiveTab('care')}
                >
                  查看详情
                </button>
              </div>
            </div>
          )}

          {topCrossDraft && (
            <div className={css.spotlightItem} data-testid="spotlight-draft-banner">
              <div className={css.spotlightBody}>
                <div>
                  <div className={css.spotlightTitle}>
                    新技能草案待审 ({growthModel.draftCount})：{topCrossDraft.name} (v{topCrossDraft.targetVersion})
                  </div>
                  <div className={css.spotlightSub}>{topCrossDraft.evidenceSummary}</div>
                </div>
              </div>
              <div className={css.actionRow}>
                <button
                  type="button"
                  className={css.primaryBtn}
                  data-testid="spotlight-approve-draft"
                  disabled={spotlightBusy}
                  onClick={() => void handleApproveDraft(topCrossDraft, true)}
                >
                  批准启用
                </button>
                <button
                  type="button"
                  className={css.btn}
                  data-testid="spotlight-jump-skills"
                  onClick={() => {
                    setActiveTab('skills');
                    setSkillSubTab('drafts');
                  }}
                >
                  审阅草案
                </button>
              </div>
            </div>
          )}

          {topCrossProspective && (
            <div
              className={css.spotlightItem}
              data-tone={topCrossProspective.priority === 'high' ? 'warn' : undefined}
              data-testid="spotlight-prospective-banner"
            >
              <div className={css.spotlightBody}>
                <div>
                  <div className={css.spotlightTitle}>
                    前瞻提醒待办 ({surfacedIntentions.length})：{topCrossProspective.title}
                  </div>
                  <div className={css.spotlightSub}>{topCrossProspective.instruction}</div>
                </div>
              </div>
              <div className={css.actionRow}>
                <button
                  type="button"
                  className={css.primaryBtn}
                  data-testid="spotlight-fulfill-prospective"
                  disabled={spotlightBusy}
                  onClick={() => void handleResolveProspective({ id: topCrossProspective.id, action: 'fulfill' }, true)}
                >
                  标记完成
                </button>
                <button
                  type="button"
                  className={css.btn}
                  data-testid="spotlight-jump-intuition"
                  onClick={() => {
                    setActiveTab('memory');
                    setMemorySubTab('intuition');
                  }}
                >
                  查看前瞻
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 4A. Tab 1: 稳态看护 */}
      {activeTab === 'care' && (
        <div
          role="tabpanel"
          id="asi-tabpanel-care"
          aria-labelledby="asi-tab-care"
          className={css.tabPanel}
          data-testid="tabpanel-care"
        >
          {careFeedback && (
            <div role="alert" className={css.alertBanner} data-testid="care-feedback">
              <span>{careFeedback}</span>
              <button type="button" className={css.textBtn} onClick={() => setCareFeedback(null)}>
                关闭
              </button>
            </div>
          )}

          {/* Open Help Cards (L1 Cries & L3 Silent Care Approvals) */}
          {openHelpCards.map((card) => {
            const busy = careBusyId === card.id;
            const age = formatAge(needsModel.now, card.updatedAt);
            const approveLabel = card.approveLabel || APPROVE_LABEL[card.actionKind];
            const needTag = card.need ? NEED_LABEL[card.need] : (card.driveLabel ?? card.driveKey ?? '高阶看护');
            return (
              <article
                key={card.id}
                className={`${css.card} ${css.cardAccent}`}
                data-help-card={card.id}
                data-zone={card.severity}
              >
                <div className={css.cardHeader}>
                  <h2 className={css.itemHeading}>{card.title}</h2>
                  <span className={css.tagPill} data-zone={card.severity}>
                    {needTag} · {ZONE_WORD[card.severity]}
                    {age === '刚刚' ? '' : ` · ${age}`}
                  </span>
                </div>
                <p className={css.mutedText}>{card.summary}</p>
                {card.actionTarget && (
                  <p className={css.mutedText}>
                    受控目标：{card.actionTarget}
                    {card.actionKind === 'clean-external-cache' ? '（自动保护 1h 内活跃项）' : ''}
                    {card.actionKind === 'run-drive-action' ? '（执行前复核活跃豁免与护栏）' : ''}
                  </p>
                )}
                {card.proposedAction && <p className={css.mutedText}>建议：{card.proposedAction}</p>}
                <div className={css.actionRow}>
                  <button
                    type="button"
                    className={css.primaryBtn}
                    disabled={busy}
                    onClick={() => void handleCareHelpAction(card.id, approveLabel, props.onApproveHelp)}
                  >
                    {approveLabel}
                  </button>
                  <button
                    type="button"
                    className={css.btn}
                    disabled={busy}
                    onClick={() => void handleCareHelpAction(card.id, '忽略求助', props.onDismissHelp)}
                  >
                    忽略
                  </button>
                </div>
              </article>
            );
          })}

          {/* L1 Five Survival Needs */}
          <section className={css.card} aria-label="L1 五大生存需求">
            <div className={css.cardHeader}>
              <h2 className={css.sectionHeading}>L1 生理生存稳态</h2>
              <span className={css.mutedText}>
                {activeL1Drives.length > 0 ? `${activeL1Drives.length} 项驱动激活` : '全部处于舒适区'}
              </span>
            </div>

            <div className={css.needStack}>
              {NEED_KEYS.map((key) => {
                const item = needsModel.needs[key];
                const sat = Math.max(0, Math.min(100, Math.round(item.satisfaction)));
                const visualZone: NeedZone =
                  item.zone === 'comfortable' && item.driveActive ? 'uncomfortable' : item.zone;
                return (
                  <div key={key} className={css.needRow} data-need={key} data-zone={item.zone}>
                    <div className={css.needRowTop}>
                      <span className={css.badgeGroup}>
                        <span className={css.needName}>{item.label || NEED_LABEL[key]}</span>
                        <span className={css.tagPill} data-zone={item.zone}>
                          {ZONE_WORD[item.zone]}
                        </span>
                        {item.driveActive && (
                          <span className={css.tagPill} data-zone="uncomfortable">
                            {item.zone === 'comfortable' ? '回滞保持' : '自维护中'}
                          </span>
                        )}
                      </span>
                      <span className={css.scoreNum}>{formatPercentValue(sat)}</span>
                    </div>
                    <div className={css.meterTrack} aria-hidden="true">
                      <i className={css.meterFill} data-zone={visualZone} style={{ width: `${sat}%` }} />
                    </div>
                    <p className={css.mutedText}>{item.summary}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Maslow L2-L4 Status Summary & Compact Self-Maintenance Controls */}
          <section className={css.card} data-higher-drives aria-label="高阶需求仲裁与自维护">
            <div className={css.cardHeader}>
              <h2 className={css.sectionHeading}>L2–L4 高阶仲裁与自维护</h2>
              {needsModel.higherOrderSuppressed && (
                <span className={css.tagPill} data-zone="uncomfortable">
                  已挂起（优先 L1 稳态）
                </span>
              )}
            </div>

            {extraDrives.length > 0 && (
              <div className={css.needStack}>
                {extraDrives.map((drv) => {
                  const sat = Math.max(0, Math.min(100, Math.round(drv.satisfaction)));
                  return (
                    <div
                      key={drv.key}
                      className={css.needRow}
                      data-drive={drv.key}
                      data-zone={drv.zone}
                      data-suppressed={drv.suppressed ? 'true' : 'false'}
                    >
                      <div className={css.needRowTop}>
                        <span className={css.badgeGroup}>
                          <span className={css.tierPill}>{`L${drv.tier}`}</span>
                          <span className={css.needName}>{drv.label}</span>
                          <span className={css.tagPill} data-zone={drv.zone}>
                            {drv.suppressed ? '已挂起' : ZONE_WORD[drv.zone]}
                          </span>
                        </span>
                        <span className={css.scoreNum}>{formatPercentValue(sat)}</span>
                      </div>
                      <p className={css.mutedText}>{drv.summary}</p>
                    </div>
                  );
                })}
              </div>
            )}

            <p className={css.mutedText}>
              本能：{needsModel.instinct.powerMode === 'eco' ? '节能降频' : '正常采样'} · 网关：
              {CONNECTIVITY_TEXT[needsModel.instinct.modelConnectivity]} · 自维护：
              {SESSION_STATUS_TEXT[needsModel.maintenanceSession.status]}（累计{' '}
              {needsModel.maintenanceSession.turnCount} 轮）
              {needsModel.maintenanceSession.circuitBrokenNeeds &&
              needsModel.maintenanceSession.circuitBrokenNeeds.length > 0
                ? ` · 熔断省流（${needsModel.maintenanceSession.circuitBrokenNeeds.map(formatNeedKeyLabel).join('、')}）`
                : ''}
            </p>

            <div className={css.actionRow}>
              <button
                type="button"
                className={css.primaryBtn}
                data-testid="trigger-check-btn"
                disabled={maintBusy || needsModel.paused || needsModel.maintenanceSession.status === 'running'}
                onClick={() => void handleMaintAction('立即自检', props.onTriggerCheck)}
              >
                立即自检
              </button>
              <button
                type="button"
                className={css.btn}
                data-testid="open-maint-session-btn"
                disabled={maintBusy || (needsModel.paused && !needsModel.maintenanceSession.sessionId)}
                onClick={() => void handleMaintAction('打开自维护会话', props.onOpenMaintenanceSession)}
              >
                查看自维护会话
              </button>
            </div>
          </section>

          {/* Collapsed-by-Default Low-Frequency Drawers */}
          <div className={css.drawerStack}>
            <details className={css.drawer} data-testid="drawer-ledger">
              <summary>
                <span>维护账本与历史记录（{needsModel.recentMaintenance.length}）</span>
                <span className={css.drawerChevron} aria-hidden="true">
                  ▸
                </span>
              </summary>
              <div className={css.drawerBody}>
                {needsModel.actionLedger && needsModel.actionLedger.length > 0 && (
                  <ul className={css.compactList} aria-label="动作收益账本">
                    {needsModel.actionLedger.slice(0, 6).map((entry) => (
                      <li key={`${entry.need}:${entry.action}`} className={css.compactListItem}>
                        <div className={css.needRowTop}>
                          <strong>
                            {formatNeedKeyLabel(entry.need)} · {entry.action}
                          </strong>
                          <span className={css.scoreNum}>
                            有效率 {Math.round(entry.successRate * 100)}% ({entry.effectiveCount}/{entry.attempts})
                          </span>
                        </div>
                        <span className={css.mutedText}>{formatLedgerCumulativeGain(entry)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {needsModel.recentMaintenance.length === 0 ? (
                  <p className={css.mutedText}>暂无自发维护记录。</p>
                ) : (
                  <ul className={css.compactList} aria-label="最近自维护记录">
                    {needsModel.recentMaintenance.slice(0, 8).map((rec) => {
                      const gainText = formatGainSummary(rec.gain);
                      const target = rec.need
                        ? NEED_LABEL[rec.need]
                        : rec.driveKey
                          ? formatNeedKeyLabel(rec.driveKey)
                          : undefined;
                      return (
                        <li key={rec.id} className={css.compactListItem}>
                          <div className={css.needRowTop}>
                            <span>
                              <strong>{ACTOR_TEXT[rec.actor]}</strong>
                              {target ? ` · ${target}` : ''}
                            </span>
                            <span className={css.scoreNum}>{OUTCOME_TEXT[rec.outcome]}</span>
                          </div>
                          <span>{rec.summary}</span>
                          <span className={css.mutedText}>
                            {rec.action} · {formatClock(rec.at)}
                            {gainText ? ` · ${gainText}` : ''}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </details>

            <details className={css.drawer} data-testid="drawer-body">
              <summary>
                <span>原始身体体征与 5m 趋势</span>
                <span className={css.drawerChevron} aria-hidden="true">
                  ▸
                </span>
              </summary>
              <div className={css.drawerBody}>
                <BodySection model={needsModel} onOpenPermissionSettings={handleOpenPermissionSettings} />
              </div>
            </details>

            <details className={css.drawer} data-testid="drawer-env">
              <summary>
                <span>当前环境与信号源</span>
                <span className={css.drawerChevron} aria-hidden="true">
                  ▸
                </span>
              </summary>
              <div className={css.drawerBody}>
                <NowSection model={needsModel} onOpenPermissionSettings={handleOpenPermissionSettings} />
              </div>
            </details>
          </div>
        </div>
      )}

      {/* 4B. Tab 2: 记忆库 & 直觉前瞻 */}
      {activeTab === 'memory' && (
        <div
          role="tabpanel"
          id="asi-tabpanel-memory"
          aria-labelledby="asi-tab-memory"
          className={css.tabPanel}
          data-testid="tabpanel-memory"
        >
          <fieldset className={css.pillRow}>
            <legend className={css.srOnly}>记忆与前瞻分区</legend>
            <button
              type="button"
              data-testid="memory-subtab-vault"
              className={`${css.filterPill} ${memorySubTab === 'vault' ? css.filterPillActive : ''}`}
              aria-pressed={memorySubTab === 'vault'}
              onClick={() => setMemorySubTab('vault')}
            >
              长期记忆 ({sleepModel.totalMemories})
            </button>
            <button
              type="button"
              data-testid="memory-subtab-intuition"
              className={`${css.filterPill} ${memorySubTab === 'intuition' ? css.filterPillActive : ''}`}
              aria-pressed={memorySubTab === 'intuition'}
              onClick={() => setMemorySubTab('intuition')}
            >
              直觉与前瞻 ({intuitionModel.surfacedCount + intuitionModel.pendingCount})
            </button>
          </fieldset>

          {memorySubTab === 'intuition' ? (
            <>
              <section className={css.card} aria-label="L3 前额叶直觉与前瞻状态">
                <div className={css.cardHeader}>
                  <span className={css.badgeGroup}>
                    <span className={css.tierPill}>L3</span>
                    <h2 className={css.sectionHeading}>直觉闪回与前瞻记忆</h2>
                    <span className={css.tagPill} data-zone={intuitionModel.drive.zone}>
                      {intuitionModel.drive.suppressed ? '已挂起' : ZONE_WORD[intuitionModel.drive.zone]}
                    </span>
                    {intuitionModel.autoIntuitionPaused && (
                      <span className={css.tagPill} data-zone="uncomfortable">
                        自动直觉已暂停
                      </span>
                    )}
                  </span>
                  <span className={css.scoreNum}>满足 {Math.round(intuitionModel.drive.satisfaction)}%</span>
                </div>

                <p className={css.mutedText}>
                  已触发 {intuitionModel.surfacedCount} · 守候中 {intuitionModel.pendingCount} · 已完成{' '}
                  {intuitionModel.fulfilledCount} · 近期闪回 {intuitionModel.recentFlashbacks.length} 次（零 Token
                  本地）
                </p>

                <div className={css.actionRow}>
                  <button
                    type="button"
                    className={css.primaryBtn}
                    data-testid="new-prospective-btn"
                    onClick={() => setCreatingProspective((v) => !v)}
                  >
                    {creatingProspective ? '收起新建' : '+ 新建前瞻提醒'}
                  </button>

                  <label className={css.toggleRow}>
                    <input
                      type="checkbox"
                      data-testid="auto-intuition-pause-toggle"
                      checked={intuitionModel.autoIntuitionPaused}
                      onChange={(e) => void handleToggleAutoIntuition(e.currentTarget.checked)}
                    />
                    暂停自动直觉入队
                  </label>
                </div>

                {intuitionFeedback && (
                  <div
                    role={intuitionIsError ? 'alert' : 'status'}
                    className={intuitionIsError ? css.alertBanner : css.feedbackBanner}
                    data-testid="intuition-feedback"
                  >
                    <span>{intuitionFeedback}</span>
                    <button
                      type="button"
                      className={css.textBtn}
                      onClick={() => {
                        setIntuitionFeedback(null);
                        setIntuitionIsError(false);
                      }}
                    >
                      关闭
                    </button>
                  </div>
                )}
              </section>

              <section className={css.card} aria-label="即时直觉风险嗅探">
                <form className={css.searchBar} onSubmit={(e) => void handleScanFlashbacksSubmit(e)}>
                  <input
                    type="search"
                    className={css.fieldInput}
                    aria-label="输入操作线索嗅探历史陷阱"
                    data-testid="intuition-scan-input"
                    placeholder="输入命令、模块或想法嗅探踩坑闪回…"
                    value={scanCueInput}
                    onChange={(e) => setScanCueInput(e.currentTarget.value)}
                  />
                  <button type="submit" className={css.btn} data-testid="intuition-scan-btn">
                    嗅探
                  </button>
                </form>

                {scanHits !== null && (
                  <div data-testid="intuition-scan-results">
                    {scanHits.length === 0 ? (
                      <p className={css.mutedText}>未发现高相关历史陷阱或疤痕，当前线索安全。</p>
                    ) : (
                      <ul className={css.compactList} aria-label="直觉嗅探命中结果">
                        {scanHits.map((hit) => (
                          <li key={hit.sourceId} className={css.compactListItem}>
                            <div className={css.needRowTop}>
                              <strong>{hit.title}</strong>
                              <span className={css.scoreNum}>置信 {Math.round(hit.score * 100)}%</span>
                            </div>
                            <span className={css.mutedText}>{hit.caution}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>

              {creatingProspective && (
                <form
                  className={css.card}
                  onSubmit={(e) => void handleCreateProspectiveSubmit(e)}
                  data-testid="create-prospective-form"
                >
                  <label className={css.fieldLabel}>
                    提醒标题
                    <input
                      type="text"
                      className={css.fieldInput}
                      required
                      value={pmTitle}
                      onChange={(e) => setPmTitle(e.currentTarget.value)}
                      placeholder="例如：发版前核对包白名单"
                    />
                  </label>
                  <label className={css.fieldLabel}>
                    触发执行指令
                    <textarea
                      className={css.fieldTextarea}
                      required
                      value={pmInstruction}
                      onChange={(e) => setPmInstruction(e.currentTarget.value)}
                      placeholder="触发时提醒自己或模型执行的具体检查事项"
                    />
                  </label>
                  <label className={css.fieldLabel}>
                    触发方式
                    <select
                      className={css.fieldSelect}
                      value={pmTriggerKind}
                      onChange={(e) => setPmTriggerKind(e.currentTarget.value as ProspectiveTriggerKind)}
                    >
                      {PROSPECTIVE_TRIGGER_KINDS.map((tk) => (
                        <option key={tk} value={tk}>
                          {PROSPECTIVE_TRIGGER_LABELS[tk]} ({tk})
                        </option>
                      ))}
                    </select>
                  </label>

                  {pmTriggerKind === 'time' && (
                    <label className={css.fieldLabel}>
                      延迟分钟数
                      <input
                        type="number"
                        min={1}
                        max={43200}
                        className={css.fieldInput}
                        value={pmDelayMins}
                        onChange={(e) => setPmDelayMins(e.currentTarget.value)}
                      />
                    </label>
                  )}

                  {pmTriggerKind === 'context' && (
                    <>
                      <label className={css.fieldLabel}>
                        工作区匹配词
                        <input
                          type="text"
                          className={css.fieldInput}
                          value={pmWorkspaceMatch}
                          onChange={(e) => setPmWorkspaceMatch(e.currentTarget.value)}
                          placeholder="例如 asi 或 demo-web"
                        />
                      </label>
                      <label className={css.fieldLabel}>
                        提示词或窗口关键词
                        <input
                          type="text"
                          className={css.fieldInput}
                          value={pmKeywordMatch}
                          onChange={(e) => setPmKeywordMatch(e.currentTarget.value)}
                          placeholder="逗号分隔，例如 release, 打包"
                        />
                      </label>
                    </>
                  )}

                  {pmTriggerKind === 'event' && (
                    <>
                      <label className={css.fieldLabel}>
                        监听事件
                        <select
                          className={css.fieldSelect}
                          value={pmEventKind}
                          onChange={(e) => setPmEventKind(e.currentTarget.value as ProspectiveEventKind)}
                        >
                          {PROSPECTIVE_EVENT_KINDS.map((ek) => (
                            <option key={ek} value={ek}>
                              {PROSPECTIVE_EVENT_LABELS[ek]} ({ek})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={css.fieldLabel}>
                        目标过滤模式（可选）
                        <input
                          type="text"
                          className={css.fieldInput}
                          value={pmTargetPattern}
                          onChange={(e) => setPmTargetPattern(e.currentTarget.value)}
                          placeholder="例如 git push 或 wire-types"
                        />
                      </label>
                    </>
                  )}

                  <label className={css.fieldLabel}>
                    优先级
                    <select
                      className={css.fieldSelect}
                      value={pmPriority}
                      onChange={(e) => setPmPriority(e.currentTarget.value as ProspectivePriority)}
                    >
                      <option value="normal">普通 (normal)</option>
                      <option value="high">高优 (high)</option>
                    </select>
                  </label>

                  <div className={css.actionRow}>
                    <button type="submit" className={css.primaryBtn}>
                      保存前瞻
                    </button>
                    <button type="button" className={css.btn} onClick={() => setCreatingProspective(false)}>
                      取消
                    </button>
                  </div>
                </form>
              )}

              <section className={css.card} aria-label="前瞻记忆筛选">
                <fieldset className={css.pillRow}>
                  <legend className={css.srOnly}>前瞻记忆状态筛选</legend>
                  <button
                    type="button"
                    data-testid="prospective-filter-active"
                    className={`${css.filterPill} ${prospectiveFilter === 'active' ? css.filterPillActive : ''}`}
                    aria-pressed={prospectiveFilter === 'active'}
                    onClick={() => setProspectiveFilter('active')}
                  >
                    待办与守候 ({activeIntentions.length})
                  </button>
                  <button
                    type="button"
                    data-testid="prospective-filter-history"
                    className={`${css.filterPill} ${prospectiveFilter === 'history' ? css.filterPillActive : ''}`}
                    aria-pressed={prospectiveFilter === 'history'}
                    onClick={() => setProspectiveFilter('history')}
                  >
                    已完成与历史 ({historyIntentions.length})
                  </button>
                </fieldset>
              </section>

              {(prospectiveFilter === 'active' ? activeIntentions : historyIntentions).length === 0 ? (
                <div className={css.card}>
                  <p className={css.mutedText} data-testid="empty-prospective-hint">
                    {prospectiveFilter === 'active'
                      ? '暂无待办前瞻提醒，可在对话中交代未来待办或点击上方新建。'
                      : '暂无已完成或归档的前瞻记录。'}
                  </p>
                </div>
              ) : (
                (prospectiveFilter === 'active' ? activeIntentions : historyIntentions).map((item) => {
                  const isActionable =
                    item.status === 'surfaced' || item.status === 'pending' || item.status === 'snoozed';
                  return (
                    <article
                      key={item.id}
                      className={css.card}
                      data-prospective-id={item.id}
                      data-prospective-status={item.status}
                    >
                      <div className={css.cardHeader}>
                        <span className={css.badgeGroup}>
                          <span className={`${css.tagPill} ${css.tagPillAccent}`}>
                            {PROSPECTIVE_TRIGGER_LABELS[item.trigger.kind]}
                          </span>
                          <span
                            className={css.tagPill}
                            data-zone={item.status === 'surfaced' ? 'uncomfortable' : 'comfortable'}
                          >
                            {PROSPECTIVE_STATUS_LABEL[item.status]}
                          </span>
                          {item.priority === 'high' && (
                            <span className={css.tagPill} data-zone="critical">
                              高优
                            </span>
                          )}
                        </span>
                        <span className={css.scoreNum}>{formatRelativeAgo(item.updatedAt, intuitionModel.now)}</span>
                      </div>

                      <h2 className={css.itemHeading}>{item.title}</h2>
                      <p className={css.mutedText}>{item.instruction}</p>
                      <p className={css.mutedText}>{item.triggerSummary}</p>

                      <div className={css.actionRow}>
                        {isActionable ? (
                          <>
                            <button
                              type="button"
                              className={css.primaryBtn}
                              aria-label={`完成 ${item.title}`}
                              onClick={() => void handleResolveProspective({ id: item.id, action: 'fulfill' })}
                            >
                              完成
                            </button>
                            <button
                              type="button"
                              className={css.btn}
                              aria-label={`延后 30m ${item.title}`}
                              onClick={() =>
                                void handleResolveProspective({ id: item.id, action: 'snooze', snoozeMinutes: 30 })
                              }
                            >
                              延后 30m
                            </button>
                            <button
                              type="button"
                              className={css.btn}
                              aria-label={`取消 ${item.title}`}
                              onClick={() => void handleResolveProspective({ id: item.id, action: 'cancel' })}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className={css.btn}
                            aria-label={`删除记录 ${item.title}`}
                            onClick={() => void handleDeleteProspective(item.id)}
                          >
                            删除记录
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })
              )}

              <details className={css.drawer} data-testid="drawer-intuition-flashbacks">
                <summary>
                  <span>近期直觉闪回与躯体标记（{intuitionModel.recentFlashbacks.length}）</span>
                  <span className={css.drawerChevron} aria-hidden="true">
                    ▸
                  </span>
                </summary>
                <div className={css.drawerBody}>
                  {intuitionModel.recentFlashbacks.length === 0 ? (
                    <p className={css.mutedText}>暂无触发的直觉闪回记录。</p>
                  ) : (
                    <ul className={css.compactList} aria-label="近期直觉闪回记录">
                      {intuitionModel.recentFlashbacks.slice(0, 8).map((fb) => (
                        <li key={fb.id} className={css.compactListItem}>
                          <div className={css.needRowTop}>
                            <strong>{fb.title}</strong>
                            <span className={css.scoreNum}>置信 {Math.round(fb.score * 100)}%</span>
                          </div>
                          <span className={css.mutedText}>{fb.caution}</span>
                          <div className={css.actionRow}>
                            <button
                              type="button"
                              className={css.btn}
                              onClick={() => void handleFlashbackFeedback(fb.sourceId, 'helpful')}
                            >
                              有帮助
                            </button>
                            <button
                              type="button"
                              className={css.btn}
                              onClick={() => void handleFlashbackFeedback(fb.sourceId, 'dismissed')}
                            >
                              降权
                            </button>
                            <button
                              type="button"
                              className={css.btn}
                              onClick={() => void handleFlashbackFeedback(fb.sourceId, 'muted')}
                            >
                              静默此源
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </>
          ) : (
            <>
              {/* Compact Sleep Readiness Bar */}
              <section className={css.card} aria-label="L2 睡眠整合状态">
                <div className={css.cardHeader}>
                  <span className={css.badgeGroup}>
                    <span className={css.tierPill}>L2</span>
                    <h2 className={css.sectionHeading}>睡眠记忆整合</h2>
                    <span className={css.tagPill} data-zone={sleepModel.drive.zone}>
                      {sleepModel.drive.suppressed ? '已挂起' : ZONE_WORD[sleepModel.drive.zone]}
                    </span>
                    {sleepModel.autoSleepPaused && (
                      <span className={css.tagPill} data-zone="uncomfortable">
                        自动睡眠已暂停
                      </span>
                    )}
                  </span>
                  <span className={css.scoreNum}>满足 {Math.round(sleepModel.drive.satisfaction)}%</span>
                </div>

                <p className={css.mutedText}>
                  待整合 {sleepModel.drive.unconsolidatedTurns}/{sleepModel.drive.turnThreshold} 轮 · {sleepQuietText} ·
                  今日自动 {sleepModel.drive.autoRunsToday}/{sleepModel.drive.dailyAutoQuota} 次 · 上次{' '}
                  {formatRelativeAgo(sleepModel.drive.lastSleepAt, sleepModel.now)}
                </p>

                <div className={css.actionRow}>
                  <button
                    type="button"
                    className={css.primaryBtn}
                    data-testid="consolidate-now-btn"
                    disabled={busyConsolidate || sleepModel.consolidating}
                    onClick={() => void handleConsolidateNow()}
                  >
                    {busyConsolidate || sleepModel.consolidating ? '睡眠整合中…' : '立即睡眠整合'}
                  </button>

                  <button
                    type="button"
                    className={css.btn}
                    data-testid="new-memory-btn"
                    onClick={() => {
                      setCreatingMemory((prev) => !prev);
                      setEditingMemoryId(null);
                    }}
                  >
                    {creatingMemory ? '收起新建' : '+ 新建记忆'}
                  </button>

                  <label className={css.toggleRow}>
                    <input
                      type="checkbox"
                      data-testid="auto-sleep-pause-toggle"
                      checked={sleepModel.autoSleepPaused}
                      onChange={(e) => void handleToggleAutoSleepPaused(e.currentTarget.checked)}
                    />
                    暂停自动睡眠
                  </label>
                </div>

                {sleepFeedback && (
                  <div role="status" className={css.feedbackBanner} data-testid="sleep-feedback">
                    <span>{sleepFeedback}</span>
                    <button type="button" className={css.textBtn} onClick={() => setSleepFeedback(null)}>
                      关闭
                    </button>
                  </div>
                )}
              </section>

              {/* Search Input & Pill Filter Bar */}
              <section className={css.card} aria-label="记忆检索与筛选">
                <div className={css.searchBar}>
                  <input
                    type="search"
                    className={css.fieldInput}
                    aria-label="搜索记忆库"
                    data-testid="memory-search-input"
                    placeholder="搜索偏好、决策、踩坑、进展…"
                    value={memQuery}
                    onChange={(e) => setMemQuery(e.currentTarget.value)}
                  />
                  {memQuery && (
                    <button type="button" className={css.btn} onClick={() => setMemQuery('')} aria-label="清空搜索词">
                      清空
                    </button>
                  )}
                </div>

                <fieldset className={css.pillRow}>
                  <legend className={css.srOnly}>记忆类型筛选</legend>
                  <button
                    type="button"
                    className={`${css.filterPill} ${kindFilter === 'all' ? css.filterPillActive : ''}`}
                    aria-pressed={kindFilter === 'all'}
                    onClick={() => setKindFilter('all')}
                  >
                    全部 ({sleepModel.totalMemories})
                  </button>
                  {MEMORY_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`${css.filterPill} ${kindFilter === k ? css.filterPillActive : ''}`}
                      aria-pressed={kindFilter === k}
                      onClick={() => setKindFilter(k)}
                    >
                      {MEMORY_KIND_LABELS[k]} ({sleepModel.countsByKind[k] ?? 0})
                    </button>
                  ))}
                </fieldset>
              </section>

              {creatingMemory && (
                <form
                  className={css.card}
                  onSubmit={(e) => void handleCreateMemorySubmit(e)}
                  data-testid="create-memory-form"
                >
                  <label className={css.fieldLabel}>
                    记忆类型
                    <select
                      className={css.fieldSelect}
                      value={createKind}
                      onChange={(e) => setCreateKind(e.currentTarget.value as MemoryKind)}
                    >
                      {MEMORY_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {MEMORY_KIND_LABELS[k]} ({k})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={css.fieldLabel}>
                    标题
                    <input
                      type="text"
                      className={css.fieldInput}
                      required
                      value={createTitle}
                      onChange={(e) => setCreateTitle(e.currentTarget.value)}
                      placeholder="简要概括记忆要点"
                    />
                  </label>
                  <label className={css.fieldLabel}>
                    详细内容
                    <textarea
                      className={css.fieldTextarea}
                      required
                      value={createContent}
                      onChange={(e) => setCreateContent(e.currentTarget.value)}
                      placeholder="结构化描述背景、结论或避坑细节"
                    />
                  </label>
                  <label className={css.fieldLabel}>
                    标签（逗号分隔）
                    <input
                      type="text"
                      className={css.fieldInput}
                      value={createTags}
                      onChange={(e) => setCreateTags(e.currentTarget.value)}
                      placeholder="例如 pnpm, typescript"
                    />
                  </label>
                  <label className={css.toggleRow}>
                    <input
                      type="checkbox"
                      checked={createPinned}
                      onChange={(e) => setCreatePinned(e.currentTarget.checked)}
                    />
                    置顶（锁定保留率 100%，永不衰减）
                  </label>
                  <div className={css.actionRow}>
                    <button type="submit" className={css.primaryBtn}>
                      保存记忆
                    </button>
                    <button type="button" className={css.btn} onClick={() => setCreatingMemory(false)}>
                      取消
                    </button>
                  </div>
                </form>
              )}

              {/* Scannable Memory Cards */}
              {filteredMemories.length === 0 ? (
                <div className={css.card}>
                  <p className={css.mutedText} data-testid="empty-memories-hint">
                    {memQuery || kindFilter !== 'all'
                      ? '没有匹配的记忆条目。'
                      : '当前记忆库为空，可通过对话睡眠整合自动沉淀或手动新建。'}
                  </p>
                </div>
              ) : (
                filteredMemories.map((item) => {
                  const retentionPct = Math.round(Math.max(0, Math.min(1, item.retention)) * 100);
                  const isEditing = editingMemoryId === item.id;
                  const isLong = item.content.length > 160;
                  const expanded = Boolean(expandedMemoryIds[item.id]);
                  const shownContent = isLong && !expanded ? `${item.content.slice(0, 158)}…` : item.content;

                  return (
                    <article
                      key={item.id}
                      className={css.card}
                      data-memory-id={item.id}
                      data-memory-kind={item.kind}
                      data-pinned={item.pinned ? 'true' : 'false'}
                    >
                      {isEditing ? (
                        <form onSubmit={(e) => void handleEditMemorySubmit(e, item.id)} data-testid="edit-memory-form">
                          <div className={css.needStack}>
                            <label className={css.fieldLabel}>
                              记忆类型
                              <select
                                className={css.fieldSelect}
                                value={editKind}
                                onChange={(e) => setEditKind(e.currentTarget.value as MemoryKind)}
                              >
                                {MEMORY_KINDS.map((k) => (
                                  <option key={k} value={k}>
                                    {MEMORY_KIND_LABELS[k]} ({k})
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className={css.fieldLabel}>
                              标题
                              <input
                                type="text"
                                className={css.fieldInput}
                                required
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.currentTarget.value)}
                              />
                            </label>
                            <label className={css.fieldLabel}>
                              详细内容
                              <textarea
                                className={css.fieldTextarea}
                                required
                                value={editContent}
                                onChange={(e) => setEditContent(e.currentTarget.value)}
                              />
                            </label>
                            <label className={css.fieldLabel}>
                              标签（逗号分隔）
                              <input
                                type="text"
                                className={css.fieldInput}
                                value={editTags}
                                onChange={(e) => setEditTags(e.currentTarget.value)}
                              />
                            </label>
                            <label className={css.toggleRow}>
                              <input
                                type="checkbox"
                                checked={editPinned}
                                onChange={(e) => setEditPinned(e.currentTarget.checked)}
                              />
                              置顶（永不衰减）
                            </label>
                            <div className={css.actionRow}>
                              <button type="submit" className={css.primaryBtn}>
                                保存修改
                              </button>
                              <button type="button" className={css.btn} onClick={() => setEditingMemoryId(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className={css.cardHeader}>
                            <span className={css.badgeGroup}>
                              <span className={`${css.tagPill} ${css.tagPillAccent}`}>
                                {MEMORY_KIND_LABELS[item.kind]}
                              </span>
                              {item.pinned && (
                                <span className={css.tagPill} data-zone="comfortable">
                                  已置顶 · 永不衰减
                                </span>
                              )}
                            </span>
                            <span className={css.scoreNum}>{formatRelativeAgo(item.updatedAt, sleepModel.now)}</span>
                          </div>

                          <h2 className={css.itemHeading}>{item.title}</h2>
                          <p className={css.mutedText}>
                            {shownContent}{' '}
                            {isLong && (
                              <button
                                type="button"
                                className={css.textBtn}
                                onClick={() => setExpandedMemoryIds((prev) => ({ ...prev, [item.id]: !expanded }))}
                              >
                                {expanded ? '收起' : '展开'}
                              </button>
                            )}
                          </p>

                          <div className={css.retentionRow}>
                            <span className={css.retentionBar} aria-hidden="true">
                              <i className={css.retentionFill} style={{ width: `${retentionPct}%` }} />
                            </span>
                            <span>
                              {item.pinned
                                ? '保留率 100%（已置顶锁定）'
                                : `FSRS 保留 ${retentionPct}% · S=${item.fsrs.stability.toFixed(1)}d · 回忆 ${item.recallCount} 次`}
                            </span>
                          </div>

                          {item.tags.length > 0 && (
                            <ul className={css.tagChips} aria-label="记忆标签">
                              {item.tags.map((tag) => (
                                <li key={tag} className={css.tagChip}>
                                  #{tag}
                                </li>
                              ))}
                            </ul>
                          )}

                          <div className={css.actionRow}>
                            <button
                              type="button"
                              className={css.btn}
                              aria-label={`${item.pinned ? '取消置顶' : '置顶'} ${item.title}`}
                              onClick={() => void handleTogglePin(item.id, !item.pinned)}
                            >
                              {item.pinned ? '取消置顶' : '置顶'}
                            </button>
                            <button
                              type="button"
                              className={css.btn}
                              aria-label={`编辑 ${item.title}`}
                              onClick={() => beginEditMemory(item)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className={css.btn}
                              aria-label={`删除 ${item.title}`}
                              onClick={() => void handleDeleteMemory(item.id)}
                            >
                              删除
                            </button>
                          </div>
                        </>
                      )}
                    </article>
                  );
                })
              )}

              {/* Collapsible Recent Sleep Journal */}
              <details className={css.drawer} data-testid="drawer-sleep-journal">
                <summary>
                  <span>最近睡眠整合日志（{sleepModel.recentConsolidations.length}）</span>
                  <span className={css.drawerChevron} aria-hidden="true">
                    ▸
                  </span>
                </summary>
                <div className={css.drawerBody}>
                  {sleepModel.recentConsolidations.length === 0 ? (
                    <p className={css.mutedText}>暂无睡眠整合记录。</p>
                  ) : (
                    <ul className={css.compactList} aria-label="最近睡眠整合记录">
                      {sleepModel.recentConsolidations.slice(0, 5).map((rec) => (
                        <li key={rec.id} className={css.compactListItem}>
                          <div className={css.needRowTop}>
                            <strong>{rec.trigger === 'manual' ? '手动整合' : '自动睡眠'}</strong>
                            <span className={css.scoreNum}>{formatRelativeAgo(rec.at, sleepModel.now)}</span>
                          </div>
                          <span className={css.mutedText}>{rec.summary}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </>
          )}
        </div>
      )}

      {/* 4C. Tab 3: 技能工坊 */}
      {activeTab === 'skills' && (
        <div
          role="tabpanel"
          id="asi-tabpanel-skills"
          aria-labelledby="asi-tab-skills"
          className={css.tabPanel}
          data-testid="tabpanel-skills"
        >
          {/* Compact L4 Status Bar */}
          <section className={css.card} aria-label="L4 技能自进化状态">
            <div className={css.cardHeader}>
              <span className={css.badgeGroup}>
                <span className={css.tierPill}>L4</span>
                <h2 className={css.sectionHeading}>技能提炼与自进化</h2>
                <span className={css.tagPill} data-zone={growthModel.drive.zone}>
                  {growthModel.drive.suppressed || growthModel.drive.lowerTierBlocked
                    ? '已挂起'
                    : ZONE_WORD[growthModel.drive.zone]}
                </span>
                {growthModel.autoGrowthPaused && (
                  <span className={css.tagPill} data-zone="uncomfortable">
                    自动提炼已暂停
                  </span>
                )}
                {growthModel.staleCount > 0 && (
                  <span className={css.tagPill} data-zone="uncomfortable">
                    待代谢 {growthModel.staleCount}
                  </span>
                )}
              </span>
              <span className={css.scoreNum}>满足 {Math.round(growthModel.drive.satisfaction)}%</span>
            </div>

            <p className={css.mutedText}>
              达标簇 {growthModel.drive.readyClusters}（记忆 {growthModel.drive.highRetentionMemoryCount} / 轨迹{' '}
              {growthModel.drive.recurringTrajectoryCount}） · {growthQuietText} · 今日自动{' '}
              {growthModel.drive.autoDraftsToday}/{growthModel.drive.dailyAutoQuota} 次
            </p>

            <div className={css.actionRow}>
              <button
                type="button"
                className={css.primaryBtn}
                data-testid="synthesize-now-btn"
                disabled={busySynthesize || growthModel.synthesizing}
                onClick={() => void handleSynthesizeNow()}
              >
                {busySynthesize || growthModel.synthesizing ? '技能提炼中…' : '立即提炼技能'}
              </button>

              <button
                type="button"
                className={css.btn}
                data-testid="new-skill-btn"
                onClick={() => {
                  setCreatingSkill((prev) => !prev);
                  setEditingSkillKey(null);
                }}
              >
                {creatingSkill ? '收起新建' : '+ 手动新建技能'}
              </button>

              <label className={css.toggleRow}>
                <input
                  type="checkbox"
                  data-testid="auto-growth-pause-toggle"
                  checked={growthModel.autoGrowthPaused}
                  onChange={(e) => void handleToggleAutoGrowthPaused(e.currentTarget.checked)}
                />
                暂停自动提炼
              </label>
            </div>

            {growthFeedback && (
              <div role="status" className={css.feedbackBanner} data-testid="growth-feedback">
                <span>{growthFeedback}</span>
                <button type="button" className={css.textBtn} onClick={() => setGrowthFeedback(null)}>
                  关闭
                </button>
              </div>
            )}
          </section>

          {/* Search & Clean Segmented Filter */}
          <section className={css.card} aria-label="技能检索与状态切换">
            <div className={css.searchBar}>
              <input
                type="search"
                className={css.fieldInput}
                aria-label="搜索技能与草案"
                data-testid="skill-search-input"
                placeholder="搜索技能名称、描述或 SKILL.md…"
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.currentTarget.value)}
              />
              {skillQuery && (
                <button type="button" className={css.btn} onClick={() => setSkillQuery('')} aria-label="清空技能搜索词">
                  清空
                </button>
              )}
            </div>

            <fieldset className={css.pillRow}>
              <legend className={css.srOnly}>技能状态视图</legend>
              <button
                type="button"
                data-testid="tab-drafts"
                className={`${css.filterPill} ${skillSubTab === 'drafts' ? css.filterPillActive : ''}`}
                aria-pressed={skillSubTab === 'drafts'}
                onClick={() => setSkillSubTab('drafts')}
              >
                待审草案 ({growthModel.draftCount})
              </button>
              <button
                type="button"
                data-testid="tab-active"
                className={`${css.filterPill} ${skillSubTab === 'active' ? css.filterPillActive : ''}`}
                aria-pressed={skillSubTab === 'active'}
                onClick={() => setSkillSubTab('active')}
              >
                已启用 (
                {growthModel.disabledCount > 0
                  ? `${growthModel.activeCount}/${growthModel.skills.length}`
                  : growthModel.activeCount}
                )
              </button>
              <button
                type="button"
                data-testid="tab-archived"
                className={`${css.filterPill} ${skillSubTab === 'archived' ? css.filterPillActive : ''}`}
                aria-pressed={skillSubTab === 'archived'}
                onClick={() => setSkillSubTab('archived')}
              >
                已归档 ({growthModel.archivedCount})
              </button>
            </fieldset>
          </section>

          {creatingSkill && (
            <form
              className={css.card}
              onSubmit={(e) => void handleCreateSkillSubmit(e)}
              data-testid="create-skill-form"
            >
              <label className={css.fieldLabel}>
                技能名称（kebab-case）
                <input
                  type="text"
                  className={css.fieldInput}
                  required
                  value={createSkillName}
                  onChange={(e) => setCreateSkillName(e.currentTarget.value)}
                  placeholder="例如 playwright-contrast-check"
                />
              </label>
              <label className={css.fieldLabel}>
                功能与触发描述（10–1024 字）
                <input
                  type="text"
                  className={css.fieldInput}
                  required
                  value={createSkillDesc}
                  onChange={(e) => setCreateSkillDesc(e.currentTarget.value)}
                  placeholder="说明技能做什么以及何时自动触发"
                />
              </label>
              <label className={css.fieldLabel}>
                适用时机（when-to-use，可选）
                <input
                  type="text"
                  className={css.fieldInput}
                  value={createSkillWhen}
                  onChange={(e) => setCreateSkillWhen(e.currentTarget.value)}
                  placeholder="例如修改侧栏样式或无障碍测试时"
                />
              </label>
              <label className={css.fieldLabel}>
                生效作用域
                <select
                  className={css.fieldSelect}
                  value={createSkillScope}
                  onChange={(e) => {
                    const nextScope = e.currentTarget.value as SkillScope;
                    setCreateSkillScope(nextScope);
                    if (nextScope === 'workspace' && !createSkillWorkspace.trim() && firstKnownWorkspacePath) {
                      setCreateSkillWorkspace(firstKnownWorkspacePath);
                    }
                  }}
                >
                  <option value="global">全局（所有工作区可用）</option>
                  <option value="workspace">仅指定工作区（cwd 隔离）</option>
                </select>
              </label>
              {createSkillScope === 'workspace' && (
                <label className={css.fieldLabel}>
                  目标工作区路径
                  <input
                    type="text"
                    className={css.fieldInput}
                    list="asi-known-workspaces"
                    required
                    value={createSkillWorkspace}
                    onChange={(e) => setCreateSkillWorkspace(e.currentTarget.value)}
                    placeholder="工作区绝对路径"
                  />
                  {growthModel.knownWorkspaces.length > 0 && (
                    <datalist id="asi-known-workspaces">
                      {growthModel.knownWorkspaces.map((ws) => (
                        <option key={ws.path} value={ws.path} label={ws.display} />
                      ))}
                    </datalist>
                  )}
                </label>
              )}
              <label className={css.fieldLabel}>
                指令正文（Markdown）
                <textarea
                  className={css.fieldTextarea}
                  required
                  value={createSkillBody}
                  onChange={(e) => setCreateSkillBody(e.currentTarget.value)}
                  placeholder={'# 技能标题\n\n## 标准步骤\n1. 先跑复现测试…'}
                />
              </label>
              <div className={css.actionRow}>
                <button type="submit" className={css.primaryBtn}>
                  生成待审草案
                </button>
                <button type="button" className={css.btn} onClick={() => setCreatingSkill(false)}>
                  取消
                </button>
              </div>
            </form>
          )}

          {/* Pending Drafts View */}
          {skillSubTab === 'drafts' &&
            (filteredDrafts.length === 0 ? (
              <div className={css.card}>
                <p className={css.mutedText} data-testid="empty-drafts-hint">
                  {normSkillQuery
                    ? '没有匹配的待审草案。'
                    : '当前无待审技能草案；积累足够踩坑记忆与排障轨迹后将在深静默期自动起草。'}
                </p>
              </div>
            ) : (
              filteredDrafts.map((draft) => {
                const editKey = `draft:${draft.id}`;
                const isEditing = editingSkillKey === editKey;
                const isPreviewing = openPreviewId === editKey;
                const isDiffOpen = openDiffDraftId === draft.id;
                const wsOptions = buildWorkspaceOptions(draft.workspacePath, draft.workspaceDisplay);
                const diffLines =
                  isDiffOpen && draft.baseMarkdown ? computeLineDiff(draft.baseMarkdown, draft.markdown) : [];

                return (
                  <article key={draft.id} className={css.card} data-draft-id={draft.id}>
                    <div className={css.cardHeader}>
                      <span className={css.badgeGroup}>
                        <span className={`${css.tagPill} ${css.tagPillAccent}`}>
                          {draft.isRevision
                            ? `增量修订 v${draft.baseVersion ?? 1} → v${draft.targetVersion}`
                            : `新草案 v${draft.targetVersion}`}
                        </span>
                        <span className={css.tagPill}>
                          {draft.scope === 'workspace' ? `工作区 · ${draft.workspaceDisplay ?? '指定目录'}` : '全局'}
                        </span>
                      </span>
                      <span className={css.scoreNum}>{formatRelativeAgo(draft.updatedAt, growthModel.now)}</span>
                    </div>

                    <h2 className={css.itemHeading}>{draft.name}</h2>
                    <p className={css.mutedText}>{draft.description}</p>
                    <p className={css.mutedText}>{draft.evidenceSummary}</p>

                    <label className={css.fieldLabel}>
                      生效作用域切换
                      <select
                        className={css.fieldSelect}
                        aria-label={`生效作用域切换 ${draft.name}`}
                        value={
                          customScopeInputByKey[editKey] !== undefined
                            ? '__custom__'
                            : encodeScopeSelectValue(draft.scope, draft.workspacePath)
                        }
                        onChange={(e) => void handleDraftScopeChange(draft, e.currentTarget.value)}
                      >
                        <option value="global">全局（所有工作区生效）</option>
                        {wsOptions.map(([wsPath, wsDisplay]) => (
                          <option key={wsPath} value={`ws:${wsPath}`}>
                            工作区：{wsDisplay}
                          </option>
                        ))}
                        <option value="__custom__">工作区：自定义路径…</option>
                      </select>
                    </label>

                    {customScopeInputByKey[editKey] !== undefined && (
                      <div className={css.inlineFieldRow}>
                        <input
                          type="text"
                          className={css.fieldInput}
                          aria-label={`自定义作用域路径 ${draft.name}`}
                          placeholder="工作区绝对路径"
                          value={customScopeInputByKey[editKey] ?? ''}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            setCustomScopeInputByKey((prev) => ({ ...prev, [editKey]: val }));
                          }}
                        />
                        <button
                          type="button"
                          className={css.btn}
                          onClick={() => void handleApplyCustomDraftScope(draft)}
                        >
                          应用工作区
                        </button>
                      </div>
                    )}

                    {isDiffOpen && draft.baseMarkdown && (
                      <section className={css.diffBox} data-testid="skill-diff-view" aria-label="版本差异对比">
                        {diffLines.map((dl) => (
                          <div
                            key={`${dl.kind}-${dl.oldLine ?? 0}-${dl.newLine ?? 0}`}
                            className={`${css.diffLine} ${
                              dl.kind === 'add' ? css.diffAdd : dl.kind === 'remove' ? css.diffRemove : ''
                            }`}
                          >
                            {dl.kind === 'add' ? '+ ' : dl.kind === 'remove' ? '- ' : '  '}
                            {dl.text}
                          </div>
                        ))}
                      </section>
                    )}

                    {isPreviewing && !isEditing && (
                      <pre className={css.codePreview} data-testid="skill-markdown-preview">
                        {draft.markdown}
                      </pre>
                    )}

                    {isEditing && (
                      <form onSubmit={(e) => void handleSaveDraftEdit(e, draft.id)} data-testid="edit-draft-form">
                        <div className={css.needStack}>
                          <label className={css.fieldLabel}>
                            编辑 SKILL.md（自动校验 agentskills 规范）
                            <textarea
                              className={css.fieldTextarea}
                              value={editMarkdown}
                              onChange={(e) => setEditMarkdown(e.currentTarget.value)}
                            />
                          </label>
                          {editValidation && !editValidation.valid && (
                            <p className={css.mutedText}>校验提示：{editValidation.errors[0]}</p>
                          )}
                          <div className={css.actionRow}>
                            <button type="submit" className={css.primaryBtn}>
                              保存草案修改
                            </button>
                            <button type="button" className={css.btn} onClick={() => setEditingSkillKey(null)}>
                              取消
                            </button>
                          </div>
                        </div>
                      </form>
                    )}

                    <div className={css.actionRow}>
                      <button
                        type="button"
                        className={css.primaryBtn}
                        aria-label={`批准启用 ${draft.name}`}
                        onClick={() => void handleApproveDraft(draft)}
                      >
                        批准启用
                      </button>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`驳回草案 ${draft.name}`}
                        onClick={() => void handleRejectDraft(draft)}
                      >
                        驳回草案
                      </button>
                      {draft.isRevision && draft.baseMarkdown && (
                        <button
                          type="button"
                          className={css.btn}
                          aria-label={`${
                            isDiffOpen ? '收起差异' : `查看 v${draft.baseVersion ?? 1} → v${draft.targetVersion} 差异`
                          } ${draft.name}`}
                          onClick={() => setOpenDiffDraftId(isDiffOpen ? null : draft.id)}
                        >
                          {isDiffOpen ? '收起差异' : `查看 v${draft.baseVersion ?? 1} → v${draft.targetVersion} 差异`}
                        </button>
                      )}
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`${isPreviewing ? '收起预览' : '预览 SKILL.md'} ${draft.name}`}
                        onClick={() => {
                          setEditingSkillKey(null);
                          setOpenPreviewId(isPreviewing ? null : editKey);
                        }}
                      >
                        {isPreviewing ? '收起预览' : '预览 SKILL.md'}
                      </button>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`编辑 SKILL.md ${draft.name}`}
                        onClick={() => beginEditMarkdown(editKey, draft.markdown)}
                      >
                        编辑 SKILL.md
                      </button>
                    </div>
                  </article>
                );
              })
            ))}

          {/* Active / Installed Skills View */}
          {skillSubTab === 'active' &&
            (filteredSkills.length === 0 ? (
              <div className={css.card}>
                <p className={css.mutedText} data-testid="empty-skills-hint">
                  {normSkillQuery ? '没有匹配的已安装技能。' : '当前尚无已启用技能；可在待审草案中一键批准启用。'}
                </p>
              </div>
            ) : (
              filteredSkills.map((skill) => {
                const editKey = `skill:${skill.name}`;
                const isEditing = editingSkillKey === editKey;
                const isPreviewing = openPreviewId === editKey;
                const wsOptions = buildWorkspaceOptions(skill.workspacePath, skill.workspaceDisplay);
                const selectedExportWs =
                  exportTargetBySkill[skill.name] ?? skill.workspacePath ?? wsOptions[0]?.[0] ?? '';
                const completionText =
                  skill.turnCompletionRate !== null
                    ? `完成率 ${Math.round(skill.turnCompletionRate * 100)}%`
                    : '尚无回合样本';

                return (
                  <article
                    key={skill.name}
                    className={css.card}
                    data-skill-name={skill.name}
                    data-skill-status={skill.status}
                    data-stale={skill.stale ? 'true' : 'false'}
                  >
                    <div className={css.cardHeader}>
                      <span className={css.badgeGroup}>
                        <span className={css.tierPill}>v{skill.version}</span>
                        <span
                          className={css.tagPill}
                          data-zone={skill.status === 'active' ? 'comfortable' : 'uncomfortable'}
                        >
                          {skill.status === 'active' ? '已启用 · 热挂载' : '已停用'}
                        </span>
                        <span className={css.tagPill}>
                          {skill.scope === 'workspace' ? `工作区 · ${skill.workspaceDisplay ?? '指定目录'}` : '全局'}
                        </span>
                        {skill.stale && (
                          <span className={css.tagPill} data-zone="uncomfortable" data-testid="stale-skill-badge">
                            {skill.daysSinceLastUse}天零调用 · 建议归档
                          </span>
                        )}
                      </span>
                    </div>

                    <h2 className={css.itemHeading}>{skill.name}</h2>
                    <p className={css.mutedText}>{skill.description}</p>
                    <p className={css.mutedText}>
                      调用 {skill.invocationCount} 次 · 最近{' '}
                      {skill.lastInvokedAt ? formatRelativeAgo(skill.lastInvokedAt, growthModel.now) : '从未调用'} ·{' '}
                      {completionText}
                    </p>
                    {skill.exportedWorkspaces.length > 0 && (
                      <p className={css.mutedText}>已导出：{skill.exportedWorkspaces.join('、')}</p>
                    )}

                    <label className={css.fieldLabel}>
                      生效作用域切换
                      <select
                        className={css.fieldSelect}
                        aria-label={`生效作用域切换 ${skill.name}`}
                        value={
                          customScopeInputByKey[editKey] !== undefined
                            ? '__custom__'
                            : encodeScopeSelectValue(skill.scope, skill.workspacePath)
                        }
                        onChange={(e) => void handleSkillScopeChange(skill, e.currentTarget.value)}
                      >
                        <option value="global">全局（所有工作区生效）</option>
                        {wsOptions.map(([wsPath, wsDisplay]) => (
                          <option key={wsPath} value={`ws:${wsPath}`}>
                            工作区：{wsDisplay}
                          </option>
                        ))}
                        <option value="__custom__">工作区：自定义路径…</option>
                      </select>
                    </label>

                    {customScopeInputByKey[editKey] !== undefined && (
                      <div className={css.inlineFieldRow}>
                        <input
                          type="text"
                          className={css.fieldInput}
                          aria-label={`自定义作用域路径 ${skill.name}`}
                          placeholder="工作区绝对路径"
                          value={customScopeInputByKey[editKey] ?? ''}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            setCustomScopeInputByKey((prev) => ({ ...prev, [editKey]: val }));
                          }}
                        />
                        <button
                          type="button"
                          className={css.btn}
                          onClick={() => void handleApplyCustomSkillScope(skill)}
                        >
                          应用工作区
                        </button>
                      </div>
                    )}

                    <div className={css.inlineFieldRow}>
                      {wsOptions.length > 0 ? (
                        <select
                          className={css.fieldSelect}
                          aria-label={`导出目标工作区 ${skill.name}`}
                          value={selectedExportWs}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            setExportTargetBySkill((prev) => ({ ...prev, [skill.name]: val }));
                          }}
                        >
                          {wsOptions.map(([wsPath, wsDisplay]) => (
                            <option key={wsPath} value={wsPath}>
                              {wsDisplay}
                            </option>
                          ))}
                          <option value="__custom__">自定义工作区路径…</option>
                        </select>
                      ) : (
                        <input
                          type="text"
                          className={css.fieldInput}
                          aria-label={`导出目标工作区 ${skill.name}`}
                          placeholder="输入导出目标工作区绝对路径…"
                          value={customExportPathBySkill[skill.name] ?? ''}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            setCustomExportPathBySkill((prev) => ({ ...prev, [skill.name]: val }));
                          }}
                        />
                      )}
                      {wsOptions.length > 0 && selectedExportWs === '__custom__' && (
                        <input
                          type="text"
                          className={css.fieldInput}
                          aria-label={`自定义导出工作区路径 ${skill.name}`}
                          placeholder="输入导出目标工作区绝对路径…"
                          value={customExportPathBySkill[skill.name] ?? ''}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            setCustomExportPathBySkill((prev) => ({ ...prev, [skill.name]: val }));
                          }}
                        />
                      )}
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`导出至 .agents/skills ${skill.name}`}
                        onClick={() => void handleExportSkill(skill, wsOptions.length > 0)}
                      >
                        导出至 .agents/skills
                      </button>
                    </div>

                    {isPreviewing && !isEditing && (
                      <pre className={css.codePreview} data-testid="skill-markdown-preview">
                        {skill.markdown}
                      </pre>
                    )}

                    {isEditing && (
                      <form onSubmit={(e) => void handleSaveSkillEdit(e, skill.name)} data-testid="edit-skill-form">
                        <div className={css.needStack}>
                          <label className={css.fieldLabel}>
                            在线编辑 SKILL.md（保存即热重载 ctx.skills）
                            <textarea
                              className={css.fieldTextarea}
                              value={editMarkdown}
                              onChange={(e) => setEditMarkdown(e.currentTarget.value)}
                            />
                          </label>
                          {editValidation && !editValidation.valid && (
                            <p className={css.mutedText}>校验提示：{editValidation.errors[0]}</p>
                          )}
                          <div className={css.actionRow}>
                            <button type="submit" className={css.primaryBtn}>
                              保存并热重载
                            </button>
                            <button type="button" className={css.btn} onClick={() => setEditingSkillKey(null)}>
                              取消
                            </button>
                          </div>
                        </div>
                      </form>
                    )}

                    <div className={css.actionRow}>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`${isPreviewing ? '收起预览' : '预览 SKILL.md'} ${skill.name}`}
                        onClick={() => {
                          setEditingSkillKey(null);
                          setOpenPreviewId(isPreviewing ? null : editKey);
                        }}
                      >
                        {isPreviewing ? '收起预览' : '预览 SKILL.md'}
                      </button>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`编辑 SKILL.md ${skill.name}`}
                        onClick={() => beginEditMarkdown(editKey, skill.markdown)}
                      >
                        编辑 SKILL.md
                      </button>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`${skill.status === 'active' ? '停用' : '启用'} ${skill.name}`}
                        onClick={() => void handleToggleSkillEnabled(skill)}
                      >
                        {skill.status === 'active' ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        className={skill.stale ? css.primaryBtn : css.btn}
                        aria-label={`归档 ${skill.name}`}
                        onClick={() => void handleArchiveSkill(skill.name)}
                      >
                        归档
                      </button>
                    </div>
                  </article>
                );
              })
            ))}

          {/* Archived Skills View */}
          {skillSubTab === 'archived' &&
            (filteredArchived.length === 0 ? (
              <div className={css.card}>
                <p className={css.mutedText} data-testid="empty-archived-hint">
                  {normSkillQuery ? '没有匹配的已归档技能。' : '当前无已归档技能。'}
                </p>
              </div>
            ) : (
              filteredArchived.map((arch) => {
                const previewKey = `arch:${arch.name}`;
                const isPreviewing = openPreviewId === previewKey;
                return (
                  <article key={arch.name} className={css.card} data-archived-name={arch.name}>
                    <div className={css.cardHeader}>
                      <span className={css.badgeGroup}>
                        <span className={css.tierPill}>v{arch.version}</span>
                        <span className={css.tagPill}>已归档</span>
                      </span>
                      <span className={css.scoreNum}>{formatRelativeAgo(arch.archivedAt, growthModel.now)}</span>
                    </div>

                    <h2 className={css.itemHeading}>{arch.name}</h2>
                    <p className={css.mutedText}>{arch.description}</p>

                    {isPreviewing && (
                      <pre className={css.codePreview} data-testid="skill-markdown-preview">
                        {arch.markdown}
                      </pre>
                    )}

                    <div className={css.actionRow}>
                      <button
                        type="button"
                        className={css.primaryBtn}
                        aria-label={`恢复启用 ${arch.name}`}
                        onClick={() => void handleRestoreSkill(arch.name)}
                      >
                        恢复启用
                      </button>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`${isPreviewing ? '收起预览' : '预览 SKILL.md'} ${arch.name}`}
                        onClick={() => setOpenPreviewId(isPreviewing ? null : previewKey)}
                      >
                        {isPreviewing ? '收起预览' : '预览 SKILL.md'}
                      </button>
                      <button
                        type="button"
                        className={css.btn}
                        aria-label={`删除归档 ${arch.name}`}
                        onClick={() => void handleDeleteArchived(arch.name)}
                      >
                        删除归档
                      </button>
                    </div>
                  </article>
                );
              })
            ))}

          {/* Collapsible Synthesis Journal Drawer */}
          <details className={css.drawer} data-testid="drawer-growth-journal">
            <summary>
              <span>最近技能提炼日志（{growthModel.recentSyntheses.length}）</span>
              <span className={css.drawerChevron} aria-hidden="true">
                ▸
              </span>
            </summary>
            <div className={css.drawerBody}>
              {growthModel.recentSyntheses.length === 0 ? (
                <p className={css.mutedText}>暂无技能提炼记录。</p>
              ) : (
                <ul className={css.compactList} aria-label="最近技能工坊动态">
                  {growthModel.recentSyntheses.slice(0, 5).map((rec) => (
                    <li key={rec.id} className={css.compactListItem}>
                      <div className={css.needRowTop}>
                        <strong>{rec.trigger === 'manual' ? '手动提炼' : '深静默提炼'}</strong>
                        <span className={css.scoreNum}>{formatRelativeAgo(rec.at, growthModel.now)}</span>
                      </div>
                      <span className={css.mutedText}>{rec.summary}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
