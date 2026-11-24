import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import remote from 'asi-growth/remote';
import { createElement as h } from 'react';
import type { GrowthPanelModel } from '../shared/types.ts';
import { createGrowthActions } from './actions.ts';
import { createFrameState, staleGrowthPanelModel } from './frame-state.ts';
import { GrowthPanel } from './GrowthPanel.tsx';

declare const ASI_GROWTH_CSS: string;

const NS = 'asi-growth';
const PANEL_ID = 'asi-growth' as MainPanelId;

const en = {
  panel: 'Skill studio',
  connecting: 'Connecting to skill studio…',
  reconnecting: 'Connection lost. Displayed skills are cached; reconnecting…',
  ended: 'Skill studio stream ended.',
  failed: 'Skill studio stream failed.',
  actionFailed: 'Skill action failed. Check current state and retry.',
  dismiss: 'Dismiss',
};

const zh: typeof en = {
  panel: '技能工坊',
  connecting: '正在连接技能工坊…',
  reconnecting: '连接已断开，当前显示为上次快照，正在重连…',
  ended: '技能工坊更新已停止。',
  failed: '技能工坊连接失败。',
  actionFailed: '技能操作失败，请检查当前状态后重试。',
  dismiss: '关闭',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'asi-growth': keyof typeof en;
  }
}

type FrameState = ReturnType<typeof createFrameState<GrowthPanelModel>>;
type ActionState = ReturnType<typeof createGrowthActions>;

interface PanelInjection {
  hooks: { frames: FrameState; actionError: ActionState };
  actions: ActionState['actions'];
  clearError: () => void;
}
type PanelProps = PropsRuntime<'main'> & InjectFace<PanelInjection> & PropsLocale<typeof NS>;

function Panel(props: PanelProps) {
  const snapshot = props.useFrames((value) => value);
  const failed = props.useActionError((value) => value);
  const model = 'value' in snapshot ? snapshot.value : undefined;
  return h(
    'div',
    {
      'data-testid': 'asi-growth-slot',
      style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 },
    },
    snapshot.status === 'live'
      ? null
      : h('div', { role: snapshot.status === 'failed' ? 'alert' : 'status' }, props.t(snapshot.status)),
    failed
      ? h(
          'div',
          { role: 'alert' },
          props.t('actionFailed'),
          h('button', { type: 'button', onClick: props.clearError }, props.t('dismiss')),
        )
      : null,
    model
      ? h(GrowthPanel, {
          model: snapshot.status === 'live' ? model : staleGrowthPanelModel(model),
          ...props.actions,
        })
      : null,
  );
}

function Icon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M8 2.2 9.5 5.7 13.2 7.2 9.5 8.7 8 12.2 6.5 8.7 2.8 7.2 6.5 5.7 8 2.2Z',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M12.3 11.2v2.4M11.1 12.4h2.4',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
    }),
  );
}

export const inject = ['remote', 'slots', 'locale', 'layout'];

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = NS;
    style.textContent = ASI_GROWTH_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'asi-growth styles');
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'asi-growth dictionaries');
  const t = ctx.locale.bind(NS);

  ctx.effect(async function* () {
    const unmount = await ctx.remote.$mount(remote);
    yield () => unmount();
    const fiber = ctx.inject(['remote.asiGrowth', 'slots', 'locale'], (scope) => {
      const frames = createFrameState<GrowthPanelModel>((disconnected) => {
        const source = scope.remote.$stream({
          name: 'skill studio',
          open: (signal: AbortSignal) => scope.remote.asiGrowth.frames(signal),
          carrierFailed: disconnected,
          ended: () => Object.assign(new Error('Skill studio stream ended'), { code: 'gateway/carrier-lost' }),
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const frame of source) yield { ...frame, value: frame.value };
          },
          dispose: () => source.dispose(),
        };
      });
      const actions = createGrowthActions(scope.remote.asiGrowth);
      scope.effect(
        () => async () => {
          actions.dispose();
          await frames.dispose();
        },
        'asi-growth frames',
      );
      scope.effect(
        () =>
          scope.slots.inject('main', () =>
            scope.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: (): PanelInjection => ({
                  hooks: { frames, actionError: actions },
                  actions: actions.actions,
                  clearError: actions.clear,
                }),
              },
              Panel,
            ),
          ),
        'asi-growth main panel',
      );
      scope.effect(
        () =>
          scope.slots.inject('sidebar.panellist', () =>
            scope.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 92, locale: NS, label: () => t('panel') },
              Icon,
            ),
          ),
        'asi-growth sidebar',
      );
    });
    yield () => fiber.dispose();
  }, 'asi-growth remote');
}
