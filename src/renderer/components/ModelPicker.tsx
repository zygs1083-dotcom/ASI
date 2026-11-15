import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelInfo, ModelRef, ProviderConfig } from '../../shared/types';

interface Props {
  value: ModelRef | null;
  models: ModelInfo[];
  providers: ProviderConfig[];
  onChange: (ref: ModelRef) => void;
  testId?: string;
  disabled?: boolean;
}

interface Group {
  provider: ProviderConfig;
  models: ModelInfo[];
}

interface PopPos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxListH: number;
  up: boolean;
}

const POP_MAX_W = 300;
const EDGE = 16;

/** 按 trigger 矩形计算 fixed 定位：宽度 min(300, vw-32)，水平夹在视口内，上下取空间更大的一侧 */
function computePos(trigger: HTMLElement | null): PopPos | null {
  if (!trigger) return null;
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(POP_MAX_W, vw - EDGE * 2);
  const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - width));
  const below = vh - r.bottom - 8;
  const above = r.top - 8;
  const up = below < 180 && above > below;
  const space = Math.min(320, Math.max(up ? above : below, 120) - 44);
  return up
    ? { left, width, bottom: vh - r.top + 6, maxListH: space, up: true }
    : { left, width, top: r.bottom + 6, maxListH: space, up: false };
}

export function ModelPicker({ value, models, providers, onChange, testId, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [pos, setPos] = useState<PopPos | null>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const enabled = providers.filter((p) => p.enabled);
    return enabled
      .map((p) => ({
        provider: p,
        models: models.filter(
          (m) =>
            m.providerId === p.id &&
            (!q ||
              m.name.toLowerCase().includes(q) ||
              m.modelId.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [models, providers, query]);

  const shown = useMemo(() => {
    if (!value) return '选择模型';
    const provider = providers.find((p) => p.id === value.providerId);
    const model = models.find((m) => m.providerId === value.providerId && m.modelId === value.modelId);
    const pName = provider?.name ?? value.providerId;
    const mName = model?.name ?? value.modelId;
    const unavailable = !provider?.enabled || !model;
    return unavailable ? `${pName} · ${mName}（不可用）` : `${pName} · ${mName}`;
  }, [value, providers, models]);

  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  };

  const reposition = () => setPos(computePos(triggerRef.current));

  // biome-ignore lint/correctness/useExhaustiveDependencies: 弹层开关为唯一触发条件，close/reposition 每次渲染重建
  useEffect(() => {
    if (!open) return;
    reposition();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.stopPropagation();
        close(true);
      }
    };
    const onScrollOrResize = () => {
      const next = computePos(triggerRef.current);
      if (!next) return;
      // 触发器滚出视口时直接关闭，避免弹层悬空
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) close(false);
      else setPos(next);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  // pos 计算完成后弹层才挂载，搜索框聚焦必须等两者就绪
  useEffect(() => {
    if (open && pos) searchRef.current?.focus();
  }, [open, pos]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意在 query 变化时重置高亮
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意在 activeIdx/open 变化时滚动
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('.mp-opt.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const pick = (m: ModelInfo) => {
    onChange({ providerId: m.providerId, modelId: m.modelId });
    close(true);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setActiveIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!flat.length) return;
      setActiveIdx(e.key === 'Home' ? 0 : flat.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = flat[activeIdx];
      if (m) pick(m);
    } else if (e.key === 'Tab') {
      // Tab 正常离开焦点，关闭弹层避免悬空
      close(false);
    }
  };

  const hasOptions = flat.length > 0;

  return (
    <div className="mp" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="mp-trigger"
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择模型"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mp-trigger-label">{shown}</span>
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="mp-pop"
            role="dialog"
            aria-label="模型选择"
            style={{
              position: 'fixed',
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
            }}
          >
            <div className="mp-search">
              <Search size={14} strokeWidth={1.5} aria-hidden />
              <input
                ref={searchRef}
                data-testid="model-search"
                type="text"
                role="combobox"
                placeholder="搜索模型…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                aria-label="搜索模型"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={hasOptions ? optId(Math.min(activeIdx, flat.length - 1)) : undefined}
              />
            </div>
            <div
              className="mp-list"
              role="listbox"
              id={listId}
              ref={listRef}
              style={{ maxHeight: pos.maxListH }}
            >
              {flat.length === 0 && <div className="mp-empty">没有匹配的模型</div>}
              {groups.map((g) => (
                <div key={g.provider.id}>
                  <div className="mp-group">{g.provider.name}</div>
                  {g.models.map((m) => {
                    const idx = flat.indexOf(m);
                    const selected = value?.providerId === m.providerId && value?.modelId === m.modelId;
                    return (
                      <button
                        key={`${m.providerId}:${m.modelId}`}
                        id={optId(idx)}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={m.name}
                        tabIndex={-1}
                        data-testid="model-option"
                        data-provider-id={m.providerId}
                        data-model-id={m.modelId}
                        className={`mp-opt${idx === activeIdx ? ' active' : ''}`}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => pick(m)}
                      >
                        <span className="mp-opt-name">{m.name}</span>
                        <span className="mp-opt-id">{m.modelId}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
