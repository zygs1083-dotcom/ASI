import { newFauxChat, send } from './actions';
import { expect, FAUX_REPLY, test } from './fixtures';

test('conversation and messages survive an application restart', async ({ dataDir, launchApp }) => {
  const first = await launchApp();
  await newFauxChat(first.page);
  await send(first.page, '你好');
  await expect(first.page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
  await expect(first.page.getByTestId('msg-assistant')).toHaveText(FAUX_REPLY);
  const conversation = first.page.getByTestId('conv-item').filter({ hasText: '你好' });
  await expect(conversation).toBeVisible();
  const id = await conversation.getAttribute('data-id');
  expect(id).toBeTruthy();
  await first.app.close();

  const second = await launchApp({ dataDir });
  const restored = second.page.getByTestId('conv-item').filter({ hasText: '你好' });
  await expect(restored).toHaveAttribute('data-id', id as string);
  await restored.click();
  await expect(second.page.getByTestId('msg-user')).toHaveText('你好');
  await expect(second.page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
  await expect(second.page.getByTestId('msg-assistant')).toHaveText(FAUX_REPLY);
});

test('a stopped reply remains aborted after restart', async ({ dataDir, launchApp }) => {
  const first = await launchApp();
  await newFauxChat(first.page);
  await send(first.page, '/slow');
  const assistant = first.page.getByTestId('msg-assistant');
  await expect(assistant).toHaveAttribute('data-status', 'streaming');
  await expect(assistant).not.toHaveText('');
  await first.page.getByTestId('composer-stop').click();
  await expect(assistant).toHaveAttribute('data-status', 'aborted');
  const conversation = first.page.getByTestId('conv-item').filter({ hasText: '/slow' });
  const id = await conversation.getAttribute('data-id');
  expect(id).toBeTruthy();
  await first.app.close();

  const second = await launchApp({ dataDir });
  const restored = second.page.getByTestId('conv-item').filter({ hasText: '/slow' });
  await expect(restored).toHaveAttribute('data-id', id as string);
  await restored.click();
  await expect(second.page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'aborted');
  await expect(second.page.getByTestId('msg-assistant')).not.toHaveAttribute('data-status', 'streaming');
});
