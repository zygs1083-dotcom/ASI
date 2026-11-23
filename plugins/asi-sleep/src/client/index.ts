import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import remote from 'asi-sleep/remote';
import { createElement as h } from 'react';
import type { SleepPanelModel } from '../shared/types.ts';
import { createSleepActions } from './actions.ts';
import { createFrameState, staleSleepPanelModel } from './frame-state.ts';
import { SleepPanel } from './SleepPanel.tsx';

declare const ASI_SLEEP_CSS: string;

const NS = 'asi-sleep';
const PANEL_ID = 'asi-sleep' as MainPanelId;

const en = {
  panel: 'Memory vault',
  connecting: 'Connecting to memory vault…',
  reconnecting: 'Connection lost. Displayed memories are cached; reconnecting…',
  ended: 'Memory vault stream ended.',
  failed: 'Memory vault stream failed.',
  actionFailed: 'Memory action failed. Check current state and retry.',
  dismiss: 'Dismiss',
};

const zh: typeof en = {
  panel: '记忆库',
  connecting: '正在连接记忆库…',
  reconnecting: '连接已断开，当前显示为上次快照，正在重连…',
  ended: '记忆库更新已停止。',
  failed: '记忆库连接失败。',
  actionFailed: '记忆操作失败，请检查当前状态后重试。',
  dismiss: '关闭',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'asi-sleep': keyof typeof en;
  }
}

type FrameState = ReturnType<typeof createFrameState<SleepPanelModel>>;
type ActionState = ReturnType<typeof createSleepActions>;

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
      'data-testid': 'asi-sleep-slot',
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
      ? h(SleepPanel, {
          model: snapshot.status === 'live' ? model : staleSleepPanelModel(model),
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
      d: 'M10.8 2.4a5.5 5.5 0 1 0 2.8 9.9 4.6 4.6 0 0 1-2.8-9.9Z',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M12.2 3.2v2.2M11.1 4.3h2.2',
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
    style.textContent = ASI_SLEEP_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'asi-sleep styles');
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'asi-sleep dictionaries');
  const t = ctx.locale.bind(NS);

  ctx.effect(async function* () {
    const unmount = await ctx.remote.$mount(remote);
    yield () => unmount();
    const fiber = ctx.inject(['remote.asiSleep', 'slots', 'locale'], (scope) => {
      const frames = createFrameState<SleepPanelModel>((disconnected) => {
        const source = scope.remote.$stream({
          name: 'memory vault',
          open: (signal: AbortSignal) => scope.remote.asiSleep.frames(signal),
          carrierFailed: disconnected,
          ended: () => Object.assign(new Error('Memory vault stream ended'), { code: 'gateway/carrier-lost' }),
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const frame of source) yield { ...frame, value: frame.value };
          },
          dispose: () => source.dispose(),
        };
      });
      const actions = createSleepActions(scope.remote.asiSleep);
      scope.effect(
        () => async () => {
          actions.dispose();
          await frames.dispose();
        },
        'asi-sleep frames',
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
        'asi-sleep main panel',
      );
      scope.effect(
        () =>
          scope.slots.inject('sidebar.panellist', () =>
            scope.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 91, locale: NS, label: () => t('panel') },
              Icon,
            ),
          ),
        'asi-sleep sidebar',
      );
    });
    yield () => fiber.dispose();
  }, 'asi-sleep remote');
}
