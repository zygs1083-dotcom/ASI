import type { WatchRule } from '@asi/sense-types';
import type { BodySource } from '../sources/body.ts';
import type { RuntimeAttention } from './attention.ts';
import type { SenseActions, TuneRequest } from './ports.ts';
import type { Settings } from './settings.ts';

export function runtimeTools(
  attention: RuntimeAttention,
  body: BodySource,
  settings: Settings,
  actions: SenseActions,
  syncRules: () => Promise<void>,
  check: () => void,
  titlesAllowed: () => boolean,
) {
  return {
    envState: (section?: 'self' | 'env' | 'observation') => {
      const state = attention.state();
      if (!titlesAllowed()) state.env.focusedWindow.value = null;
      return section ? state[section] : state;
    },
    envWatch: async (request: {
      action: 'list' | 'add' | 'remove';
      rule?: Omit<WatchRule, 'approved' | 'createdBy'>;
      id?: string;
    }) => {
      check();
      if ('param' in request) throw new Error('unsupported-param');
      if (request.action === 'list') return settings.list();
      if (request.action === 'add' && request.rule) {
        await settings.add(request.rule);
        check();
        await syncRules();
        check();
        return settings.list();
      }
      if (request.action === 'remove' && request.id) {
        const rule = settings.list().find((item) => item.id === request.id);
        if (rule?.createdBy !== 'agent') throw new Error('only agent rules can be removed');
        await actions.deleteRule(request.id);
        return settings.list();
      }
      throw new TypeError('invalid env_watch request');
    },
    bodyTune: async (request: TuneRequest) => {
      check();
      const result = await ('action' in request
        ? body.tuner.feedback(request.alertId, request.verdict)
        : body.tuner.get(request.param) === undefined
          ? Promise.reject(new Error('unsupported-param'))
          : body.tuner.propose(request));
      check();
      return result;
    },
  };
}
