import { expect, test, type Locator, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const axeSource = fs.readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
)

async function checkA11y(page: Page) {
  await page.addScriptTag({ content: axeSource })
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string }[] }> } }).axe
    return (await axe.run()).violations
  })
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'region')).toEqual([])
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
  const outline = await target.evaluate((el) => ({
    style: getComputedStyle(el).outlineStyle,
    width: parseFloat(getComputedStyle(el).outlineWidth),
  }))
  expect(outline.style).not.toBe('none')
  expect(outline.width).toBeGreaterThanOrEqual(2)
}

for (const theme of ['light', 'dark']) {
  test(`tuning-disabled 420 ${theme}: 键盘确认重置`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/?scenario=tuning-disabled&theme=${theme}`)
    const summary = page.locator('details > summary', { hasText: '规则' }).first()
    await summary.focus()
    await page.keyboard.press('Enter')
    const trigger = page.getByRole('button', { name: '重置调参' })
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    await expect(page.getByText('保存的调参数据损坏，AI 调参已停用')).toBeVisible()
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused()
    await expect(page.getByRole('alertdialog', { name: '重置调参' })).toHaveAccessibleDescription('将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习')
    await expect(page.getByRole('button', { name: '取消' })).toHaveAccessibleDescription('将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习')
    await expect(page.getByRole('button', { name: '确认重置' })).toHaveAccessibleDescription('将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习')
    await expect(page.locator('.demoAction')).toBeEmpty()
    await checkA11y(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page).toHaveScreenshot(`tuning-disabled-420-${theme}.png`, { fullPage: true })
    await page.keyboard.press('Enter')
    await expect(trigger).toBeFocused()
    await expect(page.locator('.demoAction')).toBeEmpty()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(page.locator('.demoAction')).toHaveText('重置调参')
    await expect(trigger).toHaveCount(0)
    await expect(page.getByRole('button', { name: '规则列表' })).toBeFocused()
    expect(errors).toEqual([])
  })

  test(`rebaseline-suggested 420 ${theme}: 键盘确认基线与恢复`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/?scenario=rebaseline-suggested&theme=${theme}`)
    const summary = page.locator('details > summary', { hasText: '规则' }).first()
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('保存调参数据失败，AI 调参已停用')).toBeVisible()
    await page.getByRole('button', { name: '调整日志' }).click()
    const list = page.getByRole('list', { name: '重新基线建议' })
    await expect(list).toContainText('CPU · 周二 14 时')
    await expect(list).toContainText('均值 20% → 68%')
    await expect(list).toContainText('12 个样本 · 3 个日期')
    await expect(list).toContainText('391 KB/s → 1.3 MB/s')
    await expect(list).toContainText('磁盘 /demo 剩余 · 周三 9 时')
    await expect(list).toContainText('均值 80.0 GB → 60.0 GB')
    await expect(list).toContainText('Token 上下文剩余 · 周四 11 时')
    await expect(list).toContainText('均值 50.0k → 30.0k')
    const trigger = list.getByRole('button', { name: '确认重新基线' }).first()
    await page.getByRole('button', { name: '调整日志' }).focus()
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    await expect(page.getByText('持续故障和新负载无法自动区分，请确认这是正常的新状态')).toBeVisible()
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused()
    await expect(page.getByRole('alertdialog', { name: '确认重新基线' })).toHaveAccessibleDescription(/持续故障和新负载无法自动区分/)
    await expect(page.getByRole('button', { name: '取消' })).toHaveAccessibleDescription(
      /CPU · 周二 14 时.*持续故障和新负载无法自动区分/,
    )
    await expect(page.getByRole('button', { name: '确认应用' })).toHaveAccessibleDescription(
      /CPU · 周二 14 时.*均值 20% → 68%.*持续故障和新负载无法自动区分/,
    )
    await expect(page.locator('.demoAction')).toBeEmpty()
    await checkA11y(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page).toHaveScreenshot(`rebaseline-suggested-420-${theme}.png`, { fullPage: true })
    await page.keyboard.press('Enter')
    await expect(trigger).toBeFocused()
    await expect(page.locator('.demoAction')).toBeEmpty()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(page.locator('.demoAction')).toHaveText('确认重新基线 baseline-cpu')
    await expect(list).not.toContainText('CPU · 周二 14 时')
    await expect(page.getByRole('button', { name: '调整日志' })).toBeFocused()
    await page.getByRole('button', { name: '恢复 AI 调参' }).click()
    await expect(page.locator('.demoAction')).toHaveText('恢复 AI 调参')
    await expect(page.getByText('保存调参数据失败，AI 调参已停用')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '调整日志' })).toBeFocused()
    expect(errors).toEqual([])
  })
}

for (const action of [
  { scenario: 'tuning-disabled', label: '重置调参' },
  { scenario: 'rebaseline-suggested', label: '确认重新基线' },
]) {
  test(`${action.label}: 连按 Enter、重复 keydown 和双击入口均不执行`, async ({ page }) => {
    await page.goto(`/?scenario=${action.scenario}`)
    await page.locator('details > summary', { hasText: '规则' }).first().click()
    if (action.scenario === 'rebaseline-suggested') {
      await page.getByRole('button', { name: '调整日志' }).click()
    }
    const trigger = page.getByRole('button', { name: action.label }).first()
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.demoAction')).toBeEmpty()

    await trigger.focus()
    await page.keyboard.down('Enter')
    for (let i = 0; i < 5; i++) await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await expect(page.locator('.demoAction')).toBeEmpty()
    const cancel = page.getByRole('button', { name: '取消' })
    if (await cancel.isVisible()) await cancel.click()

    await trigger.dblclick()
    await expect(page.locator('.demoAction')).toBeEmpty()
    await expect(cancel).toBeVisible()
  })
}
