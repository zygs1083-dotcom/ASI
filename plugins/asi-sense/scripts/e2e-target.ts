import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { delay, envInjections, envMessages, record, targetTurnOutcome, waitFor } from './e2e-support.ts';

async function sessionEvents(root: string, id: string): Promise<Record<string, unknown>[]> {
  async function scan(dir: string): Promise<Record<string, unknown>[] | undefined> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await scan(path);
        if (found) return found;
      } else if (entry.name.endsWith('.jsonl')) {
        const lines = (await readFile(path, 'utf8')).split('\n').slice(0, -1);
        const header: unknown = lines[0] ? JSON.parse(lines[0]) : undefined;
        if (record(header).type === 'session' && record(header).id === id) {
          return lines.slice(1).map((line) => record(JSON.parse(line)));
        }
      }
    }
    return undefined;
  }
  return (await scan(root)) ?? [];
}

async function selectedSession(page: Page): Promise<string> {
  const row = page.locator('[role="treeitem"][data-row-key^="session:"][aria-selected="true"]');
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const key = await row.getAttribute('data-row-key');
  if (!key?.startsWith('session:')) throw new Error('Selected test session is unavailable');
  return key.slice('session:'.length);
}

async function rename(page: Page, id: string, title: string): Promise<void> {
  const row = page.locator(`[data-row-key="session:${id}"]`);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename session', exact: true });
  await dialog.getByLabel('Session name').fill(title);
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function prompt(page: Page, text: string): Promise<void> {
  await page.locator('[contenteditable="true"]').first().fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).first().click();
}

function check(label: string, expected: number | boolean, actual: number | boolean): void {
  if (actual !== expected) throw new Error(`target assertion ${label}: expected=${expected}, actual=${actual}`);
}

function summary(log: Record<string, unknown>[]) {
  const settled = log.filter((event) => event.type === 'job/settled');
  const ends = log.filter((event) => event.type === 'turn/end');
  const content = JSON.stringify([...envMessages(log), ...envInjections(log)]);
  const reason = record(record(ends[ends.length - 1]?.data).reason).kind;
  return {
    turns: ends.length,
    lastTurn: ['completed', 'error', 'aborted'].includes(String(reason)) ? reason : 'other',
    lastTurnBudgetExhausted: targetTurnOutcome(log, Math.max(0, ends.length - 1)) === 'budget-exhausted',
    environmentMessages: envMessages(log).length,
    environmentInjections: envInjections(log).length,
    settledJobs: settled.length,
    expectedJob: settled.some((event) => {
      const data = record(event.data);
      return (
        data.kind === 'bash' &&
        data.label === 'sleep 150; exit 1' &&
        data.status === 'completed' &&
        typeof data.detail === 'string' &&
        /^exit code: 1(?:;|$)/.test(data.detail)
      );
    }),
    jobMessage: /job:.*exited.*1/.test(content),
    pinnedFile: content.includes('pinned-fixture.txt'),
    autoFile: content.includes('auto-fixture.txt'),
  };
}

export async function checkTargetDelivery(
  chat: Page,
  panel: Locator,
  sessionRoot: string,
  workspace: string,
  budgetExhausted: () => Promise<boolean>,
): Promise<void> {
  let older = '';
  let newer = '';
  let phase = 'initial session';
  try {
    older = await selectedSession(chat);
    phase = 'older background command';
    await prompt(
      chat,
      'Use the bash tool exactly once to run `sleep 150; exit 1` with run_in_background true. Do not wait and do not use other tools. Reply READY. When an environment update arrives, reply ACK without calling any tools.',
    );
    await waitFor(
      async () => {
        const log = await sessionEvents(sessionRoot, older);
        const bash = log.some((event) => {
          const data = record(event.data);
          if (event.type !== 'tool/call' || data.name !== 'bash' || typeof data.arguments !== 'string') return false;
          const args = record(JSON.parse(data.arguments));
          return args.command === 'sleep 150; exit 1' && args.run_in_background === true;
        });
        return bash && log.some((event) => event.type === 'turn/end') ? true : undefined;
      },
      120_000,
      'older session background command',
    );
    await rename(chat, older, 'ASI Fixture Orchard');

    await chat.getByRole('button', { name: 'New session', exact: true }).last().click();
    phase = 'newer session';
    newer = await waitFor(
      async () => {
        const id = await selectedSession(chat);
        return id !== older ? id : undefined;
      },
      15_000,
      'second session',
    );
    await prompt(chat, 'Reply READY without using any tools.');
    await waitFor(
      async () => {
        const log = await sessionEvents(sessionRoot, newer);
        return log.some((event) => event.type === 'turn/end') ? true : undefined;
      },
      120_000,
      'second session turn',
    );
    await rename(chat, newer, 'ASI Fixture River');

    const oldCount = envMessages(await sessionEvents(sessionRoot, older)).length;
    const newCount = envMessages(await sessionEvents(sessionRoot, newer)).length;
    phase = 'search and pin';
    const button = panel.getByRole('button', { name: /^Deliver to:/ });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const search = panel.getByRole('combobox', { name: 'Search conversations' });
    await search.fill('orchard');
    await expect(panel.getByRole('option', { name: /ASI Fixture Orchard/ })).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByRole('option', { name: /ASI Fixture River/ })).toHaveCount(0);
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(button).toHaveAccessibleName(/ASI Fixture Orchard/, { timeout: 20_000 });

    phase = 'pinned unowned context';
    await writeFile(join(workspace, 'pinned-fixture.txt'), 'synthetic pinned file');
    await expect(panel.locator('li[data-level]').filter({ hasText: 'pinned-fixture.txt' }).first()).toBeAttached({
      timeout: 20_000,
    });
    console.log('target e2e: unowned file observed while older session was pinned');

    phase = 'background failure';
    await waitFor(
      async () => {
        const old = summary(await sessionEvents(sessionRoot, older));
        return old.expectedJob && old.jobMessage && old.pinnedFile && old.turns >= 2 ? true : undefined;
      },
      220_000,
      'background failure and pinned environment delivery',
    );
    await delay(4_000);
    const oldAfterPin = summary(await sessionEvents(sessionRoot, older));
    const newAfterPin = summary(await sessionEvents(sessionRoot, newer));
    check('older background failure', true, oldAfterPin.expectedJob);
    check('older job message', true, oldAfterPin.jobMessage);
    check('older pinned file', true, oldAfterPin.pinnedFile);
    check('older environment increased', true, oldAfterPin.environmentMessages > oldCount);
    check('newer environment count', newCount, newAfterPin.environmentMessages);
    check('newer pinned file', false, newAfterPin.pinnedFile);
    console.log('target e2e: background failure and unowned file reached pinned older session, not newer');

    phase = 'automatic selection';
    await button.click();
    await panel.getByRole('option', { name: 'Automatic (most recently active conversation)' }).click();
    await expect(button).toHaveAccessibleName(/Automatic \(most recently active conversation\)/);
    await chat.locator(`[data-row-key="session:${newer}"]`).click();
    const turns = summary(await sessionEvents(sessionRoot, newer)).turns;
    await prompt(chat, 'Reply READY without using any tools.');
    await waitFor(
      async () => {
        const ends = (await sessionEvents(sessionRoot, newer)).filter((event) => event.type === 'turn/end');
        return ends.length > turns && record(record(ends[ends.length - 1].data).reason).kind === 'completed'
          ? true
          : undefined;
      },
      120_000,
      'newer session reactivation',
    );
    await writeFile(join(workspace, 'auto-fixture.txt'), 'synthetic auto file');
    await expect(panel.locator('li[data-level]').filter({ hasText: 'auto-fixture.txt' }).first()).toBeAttached({
      timeout: 20_000,
    });
    phase = 'automatic target delivery';
    await prompt(chat, 'Reply READY without using any tools.');
    await waitFor(
      async () => summary(await sessionEvents(sessionRoot, newer)).autoFile || undefined,
      45_000,
      'automatic newest session environment delivery',
    );
    check('older automatic file', false, summary(await sessionEvents(sessionRoot, older)).autoFile);
    check('newer automatic file', true, summary(await sessionEvents(sessionRoot, newer)).autoFile);
    const outcome = await waitFor(
      async () => targetTurnOutcome(await sessionEvents(sessionRoot, newer), turns + 1),
      120_000,
      'automatic target turn completion',
    );
    check(
      'automatic turn outcome',
      true,
      outcome === 'completed' || (outcome === 'budget-exhausted' && (await budgetExhausted())),
    );
    await delay(4_000);
    check('older automatic file after turn', false, summary(await sessionEvents(sessionRoot, older)).autoFile);
    console.log(`target e2e: automatic file context reached newer, not older; final turn ${outcome}`);
  } catch (error) {
    const oldLog = older ? await sessionEvents(sessionRoot, older) : [];
    const newLog = newer ? await sessionEvents(sessionRoot, newer) : [];
    const expected =
      phase === 'background failure'
        ? { expectedJob: true, jobMessage: true, pinnedFile: true, turnsAtLeast: 2 }
        : phase === 'automatic target delivery'
          ? { oldAutoFile: false, newAutoFile: true, finalTurn: 'completed or fixture budget exhausted' }
          : undefined;
    console.error(
      'target diagnostics:',
      JSON.stringify({
        phase,
        older: older || null,
        newer: newer || null,
        expected,
        old: summary(oldLog),
        new: summary(newLog),
      }),
    );
    throw error;
  }
}
