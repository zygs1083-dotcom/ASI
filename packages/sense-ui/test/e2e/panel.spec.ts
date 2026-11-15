import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const axeSource = fs.readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
)

const SHOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../screenshots')
const SCENARIOS = [
  'healthy',
  'memory-pressure',
  'context-almost-full',
  'permission-denied',
  'busy-events',
  'desktop-no-battery',
  'learning',
  'rapid-change',
] as const
const THEMES = ['light', 'dark'] as const
const WIDTHS = [320, 420]

const EXPECTED_COPY: Record<(typeof SCENARIOS)[number], string> = {
  healthy: '状态良好',
  'memory-pressure': '内存紧张',
  'context-almost-full': '上下文快满了',
  'permission-denied': '数据待补全',
  'busy-events': '最新 200 条',
  'desktop-no-battery': '状态良好',
  learning: '基线学习 37%',
  'rapid-change': '过量删除',
}

function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  return errors
}

async function open(page: Page, scenario: string, theme: string) {
  await page.goto(`/?scenario=${scenario}&theme=${theme}`)
  await page.getByText('环境感知').waitFor()
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function expectSectionsVisible(page: Page) {
  for (const name of ['身体', '现在', '事件流', '规则']) {
    await expect(page.locator('summary', { hasText: name }).first()).toBeVisible()
  }
}

async function axeCheck(page: Page) {
  await page.addScriptTag({ content: axeSource })
  const results = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (o?: unknown) => Promise<{ violations: { impact: string; id: string }[] }> } }).axe
    return axe.run({ resultTypes: ['violations'] })
  })
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(bad, JSON.stringify(bad.map((v) => v.id))).toEqual([])
}

test.describe('场景 × 宽度 × 主题截图与无障碍', () => {
  for (const scenario of SCENARIOS) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${scenario} ${width}px ${theme}`, async ({ page }) => {
          const errors = watchErrors(page)
          await page.setViewportSize({ width, height: 900 })
          await open(page, scenario, theme)
          await expectSectionsVisible(page)
          // rapid-change：切到 调整日志 视图再做 axe + 截图，覆盖调参子页
          if (scenario === 'rapid-change') {
            await page.getByRole('button', { name: '调整日志' }).click()
          }
          await expect(page.getByText(EXPECTED_COPY[scenario]).first()).toBeVisible()
          await expectNoOverflow(page)
          await axeCheck(page)

          fs.mkdirSync(SHOT_DIR, { recursive: true })
          const file = path.join(SHOT_DIR, `${scenario}-${width}-${theme}.png`)
          await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
          expect(fs.statSync(file).size).toBeLessThan(300 * 1024)
          expect(errors).toEqual([])
        })
      }
    }
  }
})

test.describe('宽度冒烟（无截图）', () => {
  for (const width of [280, 768, 1440]) {
    test(`healthy ${width}px light 无横向溢出`, async ({ page }) => {
      const errors = watchErrors(page)
      await page.setViewportSize({ width, height: 900 })
      await open(page, 'healthy', 'light')
      await expectSectionsVisible(page)
      await expectNoOverflow(page)
      expect(errors).toEqual([])
    })
  }
})

test.describe('交互', () => {
  test('summary 键盘开合分区', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const summary = page.locator('summary', { hasText: '事件流' })
    const details = summary.locator('..')
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(details).not.toHaveAttribute('open', '')
    await page.keyboard.press('Enter')
    await expect(details).toHaveAttribute('open', '')
  })

  test('回调生效：确认待确认规则 / 暂停 / 隐藏标题', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')

    await page.getByRole('button', { name: '确认' }).click()
    await expect(page.getByText('待确认')).toHaveCount(0)
    await expect(page.getByText('确认规则 rule-pending')).toBeVisible()

    await page.locator('label', { hasText: '窗口标题发给模型' }).locator('input').click()
    await expect(page.getByText('已隐藏', { exact: true })).toBeVisible()

    await page.locator('label', { hasText: '暂停感知' }).locator('input').click()
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible()
  })

  test('实时模式数值会更新，关闭后停住', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    await page.locator('label', { hasText: '实时模式' }).locator('input').check()
    const cell = page.locator('[data-row="cpu"]').first()
    const before = await cell.innerText()
    await page.waitForTimeout(2_400)
    const after = await cell.innerText()
    expect(after).not.toBe(before)
    // 取消勾选后数值停住
    await page.locator('label', { hasText: '实时模式' }).locator('input').uncheck()
    const frozen = await cell.innerText()
    await page.waitForTimeout(1_600)
    expect(await cell.innerText()).toBe(frozen)
  })

  test('暂停感知停住假采集，恢复后继续', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    await page.locator('label', { hasText: '实时模式' }).locator('input').check()
    const cell = page.locator('[data-row="cpu"]').first()
    await page.waitForTimeout(1_400)
    await page.locator('label', { hasText: '暂停感知' }).locator('input').check()
    const paused = await cell.innerText()
    await page.waitForTimeout(1_600)
    expect(await cell.innerText()).toBe(paused)
    await page.locator('label', { hasText: '暂停感知' }).locator('input').uncheck()
    await page.waitForTimeout(1_400)
    expect(await cell.innerText()).not.toBe(paused)
  })

  test('减少动态偏好下无过渡动画', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const dur = await page.evaluate(() => {
      const el = document.querySelector('[class*="spark"]')
      return el ? getComputedStyle(el).transitionDuration : 'MISSING'
    })
    expect(dur).toBe('0s')
  })
  test('快速变化：反馈/锁定/撤销的预览联动', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'rapid-change', 'light')
    // 噪音反馈：aria-pressed 来自 model.feedback，预览回调写回状态
    const noise = page.getByRole('button', { name: '噪音' }).first()
    await noise.click()
    await expect(noise).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.demoAction')).toContainText('反馈噪音 sig-1')
    // 调整日志视图：锁定/解锁 CPU 异常灵敏度
    await page.getByRole('button', { name: '调整日志' }).click()
    const lock = page.getByLabel('CPU 异常灵敏度锁定')
    await lock.check()
    await expect(page.locator('.demoAction')).toContainText('锁定参数 cpu.anomalySigma')
    await expect(lock).toBeChecked()
    await lock.uncheck()
    await expect(lock).not.toBeChecked()
    // 撤销第一条日志：参数退回 3 σ，条目标记已撤销
    await page.getByRole('button', { name: '撤销' }).first().click()
    await expect(page.locator('.demoAction')).toContainText('撤销调整 t-1')
    await expect(page.getByText('已撤销').first()).toBeVisible()
    await expect(page.getByText('3 σ', { exact: true })).toBeVisible()
  })
})
