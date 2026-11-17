import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTarget } from '../../src/session-target';

afterEach(cleanup);

describe('delivery target', () => {
  it('searches titles and selects a result using the keyboard', async () => {
    const onSelect = vi.fn(async () => {});
    const view = render(
      <SessionTarget
        target={{
          mode: 'auto',
          sessions: [
            { id: 'old', title: 'Fixture orchard', updatedAt: 1000, running: false },
            { id: 'new', title: 'Fixture river', updatedAt: 2000, running: true },
          ],
        }}
        now={3000}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: /投递到/ }));
    const search = view.getByRole('combobox', { name: /搜索对话/ });
    fireEvent.change(search, { target: { value: 'ORCH' } });
    expect(view.queryByText('Fixture river')).toBeNull();
    expect(view.getByText('Fixture orchard')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('old'));
  });

  it('sorts recent sessions and closes on Escape', () => {
    const view = render(
      <SessionTarget
        target={{
          mode: 'auto',
          sessions: [
            { id: 'old', title: 'Older fixture', updatedAt: 1000, running: false },
            { id: 'new', title: 'Newer fixture', updatedAt: 2000, running: false },
          ],
        }}
        now={3000}
        onSelect={async () => {}}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: /投递到/ }));
    const labels = view.getAllByRole('option').map((item) => item.textContent);
    expect(labels[1]).toContain('Newer fixture');
    expect(labels[2]).toContain('Older fixture');
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Escape' });
    expect(view.queryByRole('listbox')).toBeNull();
  });

  it('supports ArrowUp and selecting Auto, and restores focus', async () => {
    const onSelect = vi.fn(async () => {});
    const view = render(
      <SessionTarget
        target={{
          mode: 'pinned',
          sessionId: 'a',
          sessions: [{ id: 'a', title: 'Fixture', updatedAt: 1000, running: false }],
        }}
        now={3000}
        onSelect={onSelect}
      />,
    );
    const button = view.getByRole('button', { name: /投递到/ });
    fireEvent.click(button);
    const input = view.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it.each([180, 420])('keeps the search control within a %dpx panel', (width) => {
    const view = render(
      <SessionTarget
        target={{
          mode: 'auto',
          sessions: [{ id: 'a', title: 'A long synthetic conversation title', updatedAt: 1000, running: true }],
        }}
        now={3000}
        onSelect={async () => {}}
      />,
    );
    view.container.style.width = `${width}px`;
    fireEvent.click(view.getByRole('button', { name: /投递到/ }));
    const root = view.container.getBoundingClientRect();
    const search = view.getByRole('combobox').getBoundingClientRect();
    expect(search.left).toBeGreaterThanOrEqual(root.left);
    expect(search.right).toBeLessThanOrEqual(root.right);
  });
});
