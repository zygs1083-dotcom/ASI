import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SessionTarget } from '../../src/session-target'

afterEach(cleanup)

describe('delivery target', () => {
  it('searches titles and selects a result using the keyboard', async () => {
    const onSelect = vi.fn(async () => {})
    const view = render(<SessionTarget target={{
      mode: 'auto',
      sessions: [
        { id: 'old', title: 'Fixture orchard', updatedAt: 1000, running: false },
        { id: 'new', title: 'Fixture river', updatedAt: 2000, running: true },
      ],
    }} now={3000} onSelect={onSelect} />)
    fireEvent.click(view.getByRole('button', { name: /投递到/ }))
    const search = view.getByRole('combobox', { name: /搜索对话/ })
    fireEvent.change(search, { target: { value: 'ORCH' } })
    expect(view.queryByText('Fixture river')).toBeNull()
    expect(view.getByText('Fixture orchard')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('old'))
  })

  it('sorts recent sessions and closes on Escape', () => {
    const view = render(<SessionTarget target={{
      mode: 'auto',
      sessions: [
        { id: 'old', title: 'Older fixture', updatedAt: 1000, running: false },
        { id: 'new', title: 'Newer fixture', updatedAt: 2000, running: false },
      ],
    }} now={3000} onSelect={async () => {}} />)
    fireEvent.click(view.getByRole('button', { name: /投递到/ }))
    const labels = view.getAllByRole('option').map((item) => item.textContent)
    expect(labels[1]).toContain('Newer fixture')
    expect(labels[2]).toContain('Older fixture')
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Escape' })
    expect(view.queryByRole('listbox')).toBeNull()
  })
})
