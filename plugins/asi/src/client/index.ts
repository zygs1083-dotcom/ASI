import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import remote from 'asi/remote';
import { createElement as h } from 'react';
import type { AsiPanelModel } from '../host/dsh/wire-types.ts';
import { AsiPanel } from './AsiPanel.tsx';
import { createAsiActions } from './actions.ts';
import css from './asi-panel.module.css';
import { createFrameState, staleAsiPanelModel } from './frame-state.ts';
import { asiPanelModel } from './panel-model.ts';

declare const ASI_UNIFIED_CSS: string;

const NS = 'asi';
const PANEL_ID = 'asi' as MainPanelId;

const en = {
  panel: 'ASI Homeostasis',
  connecting: 'Connecting to ASI homeostasis…',
  reconnecting: 'Connection lost. Showing cached snapshot; reconnecting…',
  ended: 'ASI updates stopped.',
  failed: 'ASI connection failed.',
  retry: 'Reconnect',
  actionFailed: 'Action failed. Check current state and try again.',
  dismiss: 'Dismiss',
};

const zh: typeof en = {
  panel: 'ASI 稳态',
  connecting: '正在连接 ASI 稳态中枢…',
  reconnecting: '连接已断开，当前展示上次快照，正在重连…',
  ended: 'ASI 稳态更新已停止。',
  failed: 'ASI 稳态连接失败。',
  retry: '重新连接',
  actionFailed: '操作失败，请检查当前状态后重试。',
  dismiss: '关闭',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    asi: keyof typeof en;
  }
}

type FrameState = ReturnType<typeof createFrameState<AsiPanelModel>>;
type ActionState = ReturnType<typeof createAsiActions>;

interface PanelInjection {
  hooks: { frames: FrameState; actionError: ActionState };
  actions: ActionState['actions'];
  clearError: () => void;
  reconnect: () => void;
}
type PanelProps = PropsRuntime<'main'> & InjectFace<PanelInjection> & PropsLocale<typeof NS>;

function Panel(props: PanelProps) {
  const snapshot = props.useFrames((value) => value);
  const failed = props.useActionError((value) => value);
  const model = 'value' in snapshot ? snapshot.value : undefined;
  return h(
    'div',
    {
      'data-testid': 'asi-slot',
      className: css.slotWrap,
    },
    snapshot.status === 'live'
      ? null
      : h(
          'div',
          {
            role: snapshot.status === 'failed' ? 'alert' : 'status',
            className: snapshot.status === 'failed' ? css.slotAlertBanner : css.slotStatusBanner,
          },
          h('span', null, props.t(snapshot.status)),
          snapshot.status === 'failed' || snapshot.status === 'ended'
            ? h('button', { type: 'button', className: css.textBtn, onClick: props.reconnect }, props.t('retry'))
            : null,
        ),
    failed && !model
      ? h(
          'div',
          { role: 'alert', className: css.slotAlertBanner },
          h('span', null, props.t('actionFailed')),
          h('button', { type: 'button', className: css.textBtn, onClick: props.clearError }, props.t('dismiss')),
        )
      : null,
    model
      ? h(AsiPanel, {
          model: snapshot.status === 'live' ? model : staleAsiPanelModel(model),
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
      d: 'M8 1.6 2.6 3.8v4.2c0 3.3 2.3 6 5.4 6.6 3.1-0.6 5.4-3.3 5.4-6.6V3.8L8 1.6Z',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M4.5 8.3h1.6l1.1-2.5 1.7 4.7 1.3-3.2 0.8 1h1.5',
      stroke: 'currentColor',
      strokeWidth: 1.3,
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
    style.textContent = ASI_UNIFIED_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'asi styles');
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'asi dictionaries');
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
          // Fall back to sidebar DOM row selection.
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
    const fiber = ctx.inject(['remote.asi', 'slots', 'locale'], (scope) => {
      const frames = createFrameState<AsiPanelModel>((disconnected) => {
        const source = scope.remote.$stream({
          name: 'asi homeostasis',
          open: (signal: AbortSignal) => scope.remote.asi.frames(signal),
          carrierFailed: disconnected,
          ended: () => Object.assign(new Error('ASI stream ended'), { code: 'gateway/carrier-lost' }),
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const frame of source) yield { ...frame, value: asiPanelModel(frame.value) };
          },
          dispose: () => source.dispose(),
        };
      });
      const actions = createAsiActions(scope.remote.asi, navigateToSession);
      scope.effect(
        () => async () => {
          actions.dispose();
          await frames.dispose();
        },
        'asi frames',
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
                  reconnect: () => frames.reconnect(),
                }),
              },
              Panel,
            ),
          ),
        'asi main panel',
      );
      scope.effect(
        () =>
          scope.slots.inject('sidebar.panellist', () =>
            scope.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 90, locale: NS, label: () => t('panel') },
              Icon,
            ),
          ),
        'asi sidebar',
      );
    });
    yield () => fiber.dispose();
  }, 'asi remote');
}
