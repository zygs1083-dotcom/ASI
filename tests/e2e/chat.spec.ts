import { newFauxChat, send } from './actions';
import { expect, FAUX_REPLY, test } from './fixtures';

test('streams a reply, titles the conversation and deletes it', async ({ launchApp }) => {
  const { page } = await launchApp();
  await newFauxChat(page);
  await send(page, '你好');

  await expect(page.getByTestId('msg-user')).toHaveText('你好');
  const assistant = page.getByTestId('msg-assistant');
  await expect(assistant).toHaveAttribute('data-status', 'streaming');
  await expect(assistant).toHaveAttribute('data-status', 'done');
  await expect(assistant).toHaveText(FAUX_REPLY);

  const conversation = page.getByTestId('conv-item').filter({ hasText: '你好' });
  await expect(conversation).toBeVisible();
  await conversation.hover();
  await conversation.getByTestId('conv-delete').click();
  await expect(conversation).toHaveCount(0);
});

test('Enter sends and Shift+Enter inserts a newline', async ({ launchApp }) => {
  const { page } = await launchApp();
  await newFauxChat(page);
  const input = page.getByTestId('composer-input');
  await input.fill('first line');
  await input.press('Shift+Enter');
  await input.pressSequentially('second line');
  await expect(input).toHaveValue('first line\nsecond line');
  await expect(page.getByTestId('msg-user')).toHaveCount(0);
  await input.press('Enter');
  await expect(page.getByTestId('msg-user')).toHaveText('first line\nsecond line');
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
});

test('stopping a slow reply preserves its partial text', async ({ launchApp }) => {
  const { page } = await launchApp();
  await newFauxChat(page);
  await send(page, '/slow');
  const fullReply = page.getByTestId('msg-assistant');
  await expect(fullReply).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  const fullText = (await fullReply.textContent())?.trim() ?? '';
  expect(fullText.length).toBeGreaterThan(0);

  await newFauxChat(page);
  await send(page, '/slow');
  const assistant = page.getByTestId('msg-assistant');
  await expect(assistant).toHaveAttribute('data-status', 'streaming');
  await expect.poll(async () => (await assistant.textContent())?.trim().length ?? 0).toBeGreaterThan(0);
  const partialText = (await assistant.textContent())?.trim() ?? '';
  expect(partialText.length).toBeLessThan(fullText.length);
  await page.getByTestId('composer-stop').click();
  await expect(assistant).toHaveAttribute('data-status', 'aborted');
  const stoppedText = (await assistant.textContent())?.trim() ?? '';
  expect(stoppedText.length).toBeGreaterThan(0);
  expect(stoppedText.length).toBeLessThan(fullText.length);
});

test('a provider error appears in the conversation', async ({ launchApp }) => {
  const { page } = await launchApp();
  await newFauxChat(page);
  await send(page, '/error');
  await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('msg-error')).toBeVisible();
});
