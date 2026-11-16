import type { WatchRule } from '@asi/sense-types';
import { createWatchRule, validateRule } from '../attention/rules.ts';
import type { BodySource } from '../sources/body.ts';
import type { FileSource } from '../sources/files.ts';
import type { RuntimeAttention } from './attention.ts';
import type { SenseActions, TuneRequest } from './ports.ts';
import type { Settings } from './settings.ts';

export function pauseAction(
  settings: Settings,
  current: () => boolean,
  apply: (value: boolean) => Promise<void>,
  check: () => void,
): SenseActions['pause'] {
  let tail = Promise.resolve();
  let broken = false;
  return (value) => {
    const run = tail.then(async () => {
      check();
      if (broken) throw new Error('pause state unavailable');
      const previous = current();
      try {
        if (value !== previous) await apply(value);
        check();
        await settings.update((draft) => {
          draft.paused = value;
        });
        check();
      } catch (error) {
        if (current() !== previous) {
          try {
            check();
            await apply(previous);
          } catch (rollback) {
            broken = true;
            throw new AggregateError([error, rollback], 'pause failed and rollback failed');
          }
        }
        throw error;
      }
    });
    tail = run.catch(() => {});
    return run;
  };
}

export function runtimeTools(
  attention: RuntimeAttention,
  body: BodySource,
  settings: Settings,
  actions: SenseActions,
  files: FileSource,
  syncRules: () => Promise<void>,
  check: () => void,
  titlesAllowed: () => boolean,
  changed: () => void,
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
        const input = structuredClone(request.rule);
        const rule = createWatchRule({ ...input, createdBy: 'agent', approved: input.level !== 'wake' });
        if (validateRule(rule).length) throw new TypeError('invalid watch rule');
        if (settings.list().some((item) => item.id === rule.id)) throw new Error('rule id already exists');
        const prepared = await files.prepare(rule);
        try {
          check();
          await settings.update((draft) => {
            prepared.check();
            if (draft.rules.some((item) => item.id === rule.id)) throw new Error('rule id already exists');
            draft.rules.push(rule);
          });
          check();
          await syncRules();
          check();
        } finally {
          await prepared.release();
        }
        changed();
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
      try {
        const result = await ('action' in request
          ? body.tuner.feedback(request.alertId, request.verdict)
          : body.tuner.get(request.param) === undefined
            ? Promise.reject(new Error('unsupported-param'))
            : body.tuner.propose(request));
        check();
        if ('action' in request && result.applied) attention.feedback(request.alertId, request.verdict);
        return result;
      } finally {
        changed();
      }
    },
  };
}
