import { NeedsPanel, type NeedsPanelModel } from '@asi/sense-ui';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import remote from 'asi-needs/remote';
import { createElement as h } from 'react';
import { createActions } from './actions.ts';
import { createFrameState, stalePanelModel } from './frame-state.ts';
import { panelModel } from './panel-model.ts';

declare const ASI_NEEDS_CSS: string;

const NS = 'asi-needs';
const PANEL_ID = 'asi-needs' as MainPanelId;

const en = {
  panel: 'Survival needs',
  connecting: 'Connecting to survival homeostasis…',
  reconnecting: 'Connection lost. Displayed readings are out of date; reconnecting…',
  ended: 'Survival needs updates stopped.',
  failed: 'Survival needs updates failed.',
  actionFailed: 'The action failed. Check the current state and try again.',
  dismiss: 'Dismiss',
};

const zh: typeof en = {
  panel: '生存需求',
  connecting: '正在连接生存稳态…',
  reconnecting: '连接已断开，当前显示为上次读数，正在重连…',
  ended: '生存需求更新已停止。',
  failed: '生存需求更新失败。',
  actionFailed: '操作失败，请检查当前状态后重试。',
  dismiss: '关闭',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'asi-needs': keyof typeof en;
  }
}

type FrameState = ReturnType<typeof createFrameState<NeedsPanelModel>>;
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
    {
      'data-testid': 'asi-needs-panel',
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
      ? h(NeedsPanel, {
          model: snapshot.status === 'live' ? model : stalePanelModel(model),
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
      d: 'M1.5 8.5h3l1.6-3.8 2.4 7.1 1.9-5.1 1.2 1.8h2.9',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

export const inject = ['remote', 'slots', 'locale', 'layout'];

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = NS;
    style.textContent = ASI_NEEDS_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'asi-needs styles');
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'asi-needs dictionaries');
  const t = ctx.locale.bind(NS);

  const navigateToSession = (sessionId: string) => {
    ctx.layout.selectPanel(null);
    const navSignal = ctx.layout.beginNavigation?.();

    const tryServiceSelect = (): boolean => {
      const lookup = ctx as Context & {
        get(name: string): { selectSession?: (id: string) => void; openSession?: (id: string) => void } | undefined;
      };
      for (const serviceName of ['uiSession', 'uiWorkspace', 'sessions']) {
        try {
          const svc = lookup.get(serviceName);
          if (typeof svc?.selectSession === 'function') {
            svc.selectSession(sessionId);
            return true;
          }
          if (typeof svc?.openSession === 'function') {
            svc.openSession(sessionId);
            return true;
          }
        } catch {
          // Optional service lookup or selection failed; fall back to sidebar DOM row.
        }
      }
      return false;
    };

    const tryClickSidebarRow = (): boolean => {
      if (typeof document === 'undefined') return false;
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(sessionId) : sessionId;
      const row = document.querySelector<HTMLElement>(`[data-row-key="session:${escaped}"]`);
      if (!row) return false;
      row.click();
      return true;
    };

    if (tryServiceSelect()) return;
    if (tryClickSidebarRow()) return;
    if (typeof document === 'undefined') return;

    let attempts = 0;
    const retry = () => {
      if (navSignal?.aborted || attempts >= 10) return;
      attempts += 1;
      if (tryClickSidebarRow()) return;
      setTimeout(retry, 80);
    };
    setTimeout(retry, 60);
  };

  ctx.effect(async function* () {
    const unmount = await ctx.remote.$mount(remote);
    yield () => unmount();
    const fiber = ctx.inject(['remote.asiNeeds', 'slots', 'locale'], (scope) => {
      const frames = createFrameState<NeedsPanelModel>((disconnected) => {
        const source = scope.remote.$stream({
          name: 'survival needs',
          open: (signal: AbortSignal) => scope.remote.asiNeeds.frames(signal),
          carrierFailed: disconnected,
          ended: () => Object.assign(new Error('Survival needs stream ended'), { code: 'gateway/carrier-lost' }),
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const frame of source) yield { ...frame, value: panelModel(frame.value) };
          },
          dispose: () => source.dispose(),
        };
      });
      const actions = createActions(scope.remote.asiNeeds, navigateToSession);
      scope.effect(
        () => async () => {
          actions.dispose();
          await frames.dispose();
        },
        'asi-needs frames',
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
        'asi-needs main panel',
      );
      scope.effect(
        () =>
          scope.slots.inject('sidebar.panellist', () =>
            scope.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 90, locale: NS, label: () => t('panel') },
              Icon,
            ),
          ),
        'asi-needs sidebar',
      );
    });
    yield () => fiber.dispose();
  }, 'asi-needs remote');
}
