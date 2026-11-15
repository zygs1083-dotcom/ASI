import type { KeyboardEvent } from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}

export function Switch({ checked, onChange, disabled, ariaLabel, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  testId?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
}

/** WAI-ARIA radio 样式的分段控件：方向键/Home/End 移动选择，roving tabindex */
export function Segmented<T extends string>({ value, onChange, options, ariaLabel }: SegmentedProps<T>) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + options.length) % options.length;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const btns = e.currentTarget.parentElement?.querySelectorAll('button');
    (btns?.[next] as HTMLButtonElement | undefined)?.focus();
    onChange(options[next].value);
  };
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: 自定义分段控件，已实现 radio 键盘语义
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.label}
          tabIndex={o.value === value ? 0 : -1}
          data-testid={o.testId}
          className={`seg-item${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
