import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { delay, envMessages, record, waitFor } from './e2e-support.ts';

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

export async function checkTargetDelivery(chat: Page, panel: Locator, sessionRoot: string): Promise<void> {
  const older = await selectedSession(chat);
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
  const newer = await waitFor(
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

  await waitFor(
    async () => {
      const old = envMessages(await sessionEvents(sessionRoot, older));
      return old.length > oldCount ? true : undefined;
    },
    200_000,
    'selected session environment message',
  );
  await delay(4_000);
  expect(envMessages(await sessionEvents(sessionRoot, older))).toHaveLength(oldCount + 1);
  expect(envMessages(await sessionEvents(sessionRoot, newer))).toHaveLength(newCount);
  console.log(
    'target e2e: two synthetic sessions, searched and selected older; exactly one environment message in selected session, none in newer',
  );
}
