import { SensePanel, type SensePanelModel } from '@asi/sense-ui';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import remote from 'asi-sense/remote';
import { createElement as h } from 'react';
import { createActions } from './actions.ts';
import { createFrameState, stalePanelModel } from './frame-state.ts';
import { panelModel } from './panel-model.ts';

declare const ASI_SENSE_CSS: string;

const NS = 'asi-sense';
const PANEL_ID = 'asi-sense' as MainPanelId;
const en = {
  panel: 'Environment sense',
  connecting: 'Connecting to environment sense…',
  reconnecting: 'Connection lost. Displayed environment data is out of date; reconnecting…',
  ended: 'Environment updates stopped.',
  failed: 'Environment updates failed.',
  actionFailed: 'The action failed. Check the current state and try again.',
  dismiss: 'Dismiss',
};
const zh: typeof en = {
  panel: '环境感知',
  connecting: '正在连接环境感知…',
  reconnecting: '连接已断开，当前环境数据已过时，正在重新连接…',
  ended: '环境更新已停止。',
  failed: '环境更新失败。',
  actionFailed: '操作失败，请检查当前状态后重试。',
  dismiss: '关闭',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'asi-sense': keyof typeof en;
  }
}

type FrameState = ReturnType<typeof createFrameState<SensePanelModel>>;
type ActionState = ReturnType<typeof createActions>;
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
    { 'data-testid': 'asi-sense-panel' },
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
      ? h(SensePanel, { model: snapshot.status === 'live' ? model : stalePanelModel(model), ...props.actions })
      : null,
  );
}

function Icon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.4 }),
    h('circle', { cx: 8, cy: 8, r: 2, fill: 'currentColor' }),
  );
}

export const inject = ['remote', 'slots', 'locale'];

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = NS;
    style.textContent = ASI_SENSE_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'asi-sense styles');
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'asi-sense dictionaries');
  const t = ctx.locale.bind(NS);
  ctx.effect(async function* () {
    const unmount = await ctx.remote.$mount(remote);
    yield () => unmount();
    const fiber = ctx.inject(['remote.asiSense', 'slots', 'locale'], (scope) => {
      const frames = createFrameState<SensePanelModel>((disconnected) => {
        const source = scope.remote.$stream({
          name: 'environment sense',
          open: (signal: AbortSignal) => scope.remote.asiSense.frames(signal),
          carrierFailed: disconnected,
          ended: () => Object.assign(new Error('Environment stream ended'), { code: 'gateway/carrier-lost' }),
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const frame of source) yield { ...frame, value: panelModel(frame.value) };
          },
          dispose: () => source.dispose(),
        };
      });
      const actions = createActions(scope.remote.asiSense);
      scope.effect(
        () => async () => {
          actions.dispose();
          await frames.dispose();
        },
        'asi-sense frames',
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
        'asi-sense main panel',
      );
      scope.effect(
        () =>
          scope.slots.inject('sidebar.panellist', () =>
            scope.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 90, locale: NS, label: () => t('panel') },
              Icon,
            ),
          ),
        'asi-sense sidebar',
      );
    });
    yield () => fiber.dispose();
  }, 'asi-sense remote');
}
