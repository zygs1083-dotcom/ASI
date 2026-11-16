import { appendFileSync, writeFileSync } from 'node:fs';

export const name = 'asi-sense-e2e-budget';
export const inject = ['llm'];

export function apply(ctx, config) {
  let count = 0;
  ctx.on('llm/stream', async function* (_options, next) {
    if (count >= config.limit) throw new Error('E2E model request budget exhausted');
    count += 1;
    appendFileSync(config.counter, '1\n', { mode: 0o600 });
    yield* next();
  });
  writeFileSync(config.ready, 'ready\n', { mode: 0o600 });
  ctx.effect(() => {
    const timer = setTimeout(() => {
      const services = [
        'directoryPicker',
        'directoryPickerController',
        'workspaceController',
        'workspaceRegistry',
        'storageDomain',
        'sessionPersistence',
      ];
      writeFileSync(
        config.services,
        JSON.stringify(Object.fromEntries(services.map((service) => [service, Boolean(ctx.get(service))]))),
        { mode: 0o600 },
      );
    }, 3000);
    return () => clearTimeout(timer);
  });
}
