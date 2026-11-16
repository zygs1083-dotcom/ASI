import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { envFollowups, events, record, waitFor } from './e2e-support.ts';

export async function setupFileHost(root: string, workspace: string, overlay: string): Promise<string> {
  const plugin = join(root, 'file-test-plugin');
  await mkdir(plugin);
  for (let i = 0; i < 5; i++) await writeFile(join(workspace, `sample-${i}.txt`), 'initial');
  await writeFile(join(root, 'replacement'), 'replacement');
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({
      name: 'asi-sense-e2e-file-host',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './index.js',
    }),
  );
  await writeFile(
    join(plugin, 'index.js'),
    `
import { access, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export const name = 'asi-sense-e2e-file-host';
export const inject = ['agents'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopped = false;
    let stage = 'waiting';
    const handles = [];
    const work = (async () => {
      for (let i = 0; i < 5 && !stopped; i++) {
        while (!stopped && !(await access(join(config.root, 'activate-' + i)).then(() => true, () => false)))
          await new Promise(resolve => setTimeout(resolve, 50));
        if (stopped) break;
        stage = 'agent creation';
        const handle = await ctx.agents.create({
          sessionId: randomUUID(), meta: { cwd: config.workspace },
          agentOptions: { provider: 'magpie', model: 'auto/gpt-6.1-sol' },
        });
        handles.push(handle);
        stage = 'agent initialization';
        handle.agent.followup({
          id: randomUUID(), role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'Start file test session.' }],
        });
        await handle.agent.whenIdle();
        await writeFile(join(config.root, 'active-' + i), 'ready');
        stage = 'waiting';
      }
    })().catch(async error => {
      await writeFile(join(config.root, 'file-test-error'), JSON.stringify({
        stage, name: error instanceof Error ? error.name : 'error', code: error?.code ?? null,
        noFactory: String(error?.message).includes('no agent factory registered'),
      }));
    });
    return async () => {
      stopped = true;
      await work;
      for (const handle of handles.reverse()) await handle.dispose();
    };
  });
}
`,
  );
  await appendFile(
    overlay,
    `- insert:\n    - id: asi-sense-e2e-file-host\n      name: asi-sense-e2e-file-host\n      config:\n        root: ${JSON.stringify(root)}\n        workspace: ${JSON.stringify(workspace)}\n`,
  );
  return plugin;
}

export async function checkFileHost(
  root: string,
  workspace: string,
  sessionRoot: string,
  panel: Locator,
): Promise<void> {
  const source = panel.getByText('files:e2e-agent-file', { exact: true }).locator('..');
  await expect(source).toContainText('正常', { timeout: 20_000 });
  console.log('File source status: ok');
  const streamMs: number[] = [];
  const deliveryMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    await writeFile(join(root, `activate-${i}`), 'activate');
    await waitFor(
      async () => {
        if (
          await access(join(root, 'file-test-error')).then(
            () => true,
            () => false,
          )
        ) {
          console.error('File fixture status:', await readFile(join(root, 'file-test-error'), 'utf8'));
          throw new Error('File host fixture failed');
        }
        return access(join(root, `active-${i}`)).then(
          () => true,
          () => undefined,
        );
      },
      30_000,
      'real DSH agent activation',
    );
    const name = `sample-${i}.txt`;
    console.log(`File sample ${i + 1}: real DSH agent active`);
    const path = join(workspace, name);
    const row = panel.locator('li[data-level]').filter({ hasText: name });
    const start = performance.now();
    const stream = row
      .first()
      .waitFor({ state: 'attached', timeout: 8000 })
      .then(() => performance.now() - start);
    const delivery = waitFor(
      async () =>
        envFollowups(await events(sessionRoot)).find((event) =>
          JSON.stringify(record(event.data).inserted).includes(name),
        ),
      12_000,
      'file delivery in real DSH inbox',
    ).then(() => performance.now() - start);
    if (i === 0) await rename(join(root, 'replacement'), path);
    else await appendFile(path, 'written');
    const observed = await stream;
    console.log(
      `File sample ${i + 1}: event level=${await row.first().getAttribute('data-level')}, no-session=${await row.first().evaluate((element) => element.textContent?.includes('no-session') ?? false)}`,
    );
    if (i === 0) {
      const before = await row.count();
      await appendFile(path, 'second write');
      await expect(row).toHaveCount(before + 1, { timeout: 8000 });
    }
    streamMs.push(observed);
    try {
      deliveryMs.push(await delivery);
    } catch (error) {
      const log = await events(sessionRoot);
      console.error(
        'File delivery diagnostics:',
        JSON.stringify({
          types: Object.fromEntries(
            [...new Set(log.map((event) => String(event.type)))].map((type) => [
              type,
              log.filter((event) => event.type === type).length,
            ]),
          ),
          turnReasons: log
            .filter((event) => event.type === 'turn/end')
            .map((event) => record(record(record(event.data).reason)).kind),
          followups: envFollowups(log).length,
        }),
      );
      throw error;
    }
    console.log(`File sample ${i + 1}: DOM and real DSH inbox observed`);
  }
  await expect(source).toContainText('正常');
  const summary = (values: number[]) => {
    const rounded = values.map(Math.round);
    const sorted = rounded.toSorted((a, b) => a - b);
    return { samples: rounded, p50: sorted[2], max: sorted[4] };
  };
  console.log('Atomic rename and subsequent write: passed; source files:e2e-agent-file: ok');
  console.log('File operation to sidebar event DOM (ms):', JSON.stringify(summary(streamMs)));
  console.log('File operation to real DSH environment inbox (ms):', JSON.stringify(summary(deliveryMs)));
  expect(streamMs.every((value) => value <= 2000)).toBe(true);
}
