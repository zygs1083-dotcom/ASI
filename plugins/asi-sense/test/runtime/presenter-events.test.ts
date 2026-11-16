import { expect, it, vi } from 'vitest';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';

it('redacts old and new window events when title sharing is disabled', async () => {
  let titles = true;
  const attention = new RuntimeAttention(
    { wall: () => 100, mono: () => 0 },
    {
      deliver: async () => {},
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      tokenSnapshot: async () => undefined,
    },
    () => [],
    () => {},
    () => titles,
    vi.fn(),
    new FactExpiry({ mono: () => 0 }),
  );
  await attention.accept({
    id: 'a',
    kind: 'window.focused',
    subject: 'synthetic-title',
    at: 100,
    source: { id: 'test', api: 'test', host: 'local' },
    data: { title: 'synthetic-title', another: 'synthetic-title' },
  });
  expect(attention.events()[0]?.subject).toBe('synthetic-title');
  titles = false;
  expect(JSON.stringify(attention.events())).not.toContain('synthetic-title');
});
