import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const axeSource = fs.readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
)

const RESULTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test-results',
)
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
  'rapid-change': '磁盘 9 分钟后见底',
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
    await expect(
      page.locator('details > summary', { hasText: name }).first(),
    ).toBeVisible()
  }
}

async function axeCheck(page: Page) {
  await page.addScriptTag({ content: axeSource })
  const results = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (o?: unknown) => Promise<{ violations: { impact: string; id: string }[] }> } }).axe
    return axe.run({ resultTypes: ['violations'] })
  })
  const bad = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'region',
  )
  expect(bad, JSON.stringify(bad.map((v) => v.id))).toEqual([])
}

function tile(page: Page, key: string) {
  return page.locator(`details[data-tile="${key}"]`)
}

async function openTile(page: Page, key: string) {
  const t = tile(page, key)
  if (!(await t.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await t.locator('summary').click()
  }
  return t
}

async function openSection(page: Page, name: string) {
  const summary = page.locator('details > summary', { hasText: name }).first()
  if (!(await summary.evaluate((s) => (s.closest('details') as HTMLDetailsElement).open))) {
    await summary.click()
  }
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
          await expect(page.getByText(EXPECTED_COPY[scenario]).first()).toBeVisible()
          if (scenario === 'permission-denied') {
            const disks = tile(page, 'disks').locator('summary')
            await expect(disks).toContainText('未知')
            await expect(disks).not.toContainText('已过期')
          }
          await expectNoOverflow(page)
          await axeCheck(page)

          await expect(page).toHaveScreenshot(`${scenario}-${width}-${theme}.png`, { fullPage: true })
          expect(errors).toEqual([])
        })
      }
    }
  }
})

test.describe('展开明细截图（Token / 磁盘，420px × 明暗）', () => {
  const cases = [
    { name: 'tokens', scenario: 'context-almost-full', tile: 'tokens' },
    { name: 'disks', scenario: 'rapid-change', tile: 'disks' },
  ] as const
  for (const c of cases) {
    for (const theme of THEMES) {
      test(`detail-${c.name} 420 ${theme}`, async ({ page }) => {
        const errors = watchErrors(page)
        await page.setViewportSize({ width: 420, height: 900 })
        await open(page, c.scenario, theme)
        const t = await openTile(page, c.tile)
        // 展开图坐标与来源可见
        await expect(t.getByText('-5 分钟').first()).toBeVisible()
        await expect(t.getByText('现在', { exact: true }).first()).toBeVisible()
        await expect(t.getByText(/来源/).first()).toBeVisible()
        await axeCheck(page)
        await expect(page).toHaveScreenshot(`detail-${c.name}-420-${theme}.png`, { fullPage: true })
        expect(errors).toEqual([])
      })
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

test.describe('布局几何', () => {
  test('healthy 420px 面板高度 ≤1600，测量证据写入 test-results', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const rect = await page.locator('[data-panel]').boundingBox()
    expect(rect).toBeTruthy()
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'panel-height.json'),
      JSON.stringify(
        { selector: '[data-panel]', viewport: 420, boundingRect: rect },
        null,
        2,
      ),
    )
    expect(rect!.height).toBeLessThanOrEqual(1600)
  })

  test('两列网格：Token 跨满整行，CPU 迷你柱同一行', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await open(page, 'healthy', 'light')
    const grid = page.locator('div[class*="tiles"]').first()
    const gridBox = (await grid.boundingBox())!
    const tokenBox = (await tile(page, 'tokens').boundingBox())!
    expect(tokenBox.width).toBeGreaterThan(gridBox.width - 8)
    const cpuBox = (await tile(page, 'cpu').boundingBox())!
    expect(cpuBox.width).toBeLessThan(gridBox.width * 0.6)

    // 迷你柱底边对齐 = 同一行（高度不一，比较 bottom 而非 top）
    const bottoms = await page
      .locator('details[data-tile="cpu"] span[class*="cores"] > i')
      .evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().bottom)),
      )
    expect(new Set(bottoms).size).toBe(1)
  })

  test('环形图 ≥88px，默认趋势图 ≥28px，展开图 ≥100px', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const ring = await page.locator('svg[class*="ring"]').first().boundingBox()
    expect(ring!.height).toBeGreaterThanOrEqual(88)
    const spark = await page
      .locator('details[data-tile="cpu"] svg[class*="spark"]')
      .first()
      .boundingBox()
    expect(spark!.height).toBeGreaterThanOrEqual(28)
    const cpu = await openTile(page, 'cpu')
    const big = await cpu.locator('svg[class*="chartExpanded"]').first().boundingBox()
    expect(big!.height).toBeGreaterThanOrEqual(100)
  })

  test('分区 summary 粘性且不透明', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const summary = page.locator('details > summary', { hasText: '身体' }).first()
    const pos = await summary.evaluate((el) => {
      const s = getComputedStyle(el)
      return { position: s.position, bg: s.backgroundColor, z: s.zIndex }
    })
    expect(pos.position).toBe('sticky')
    expect(pos.bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(Number(pos.z)).toBeGreaterThan(0)
  })

  test('非减弱动态下四种严重度脉冲周期互不相同', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const durations = await page.evaluate(() => {
      const pulse = document.querySelector('[class*="ecgPulse"]')!
      const monitor = pulse.closest('[class*="monitor"]')!
      const out: Record<string, string> = {}
      for (const sev of ['good', 'warn', 'critical', 'unknown']) {
        monitor.setAttribute('data-sev', sev)
        out[sev] = getComputedStyle(pulse).animationDuration
      }
      return out
    })
    expect(new Set(Object.values(durations)).size).toBe(4)
  })

  test('减弱动态偏好下脉冲静止（animation: none）', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const name = await page.evaluate(
      () => getComputedStyle(document.querySelector('[class*="ecgPulse"]')!).animationName,
    )
    expect(name).toBe('none')
  })
})

test.describe('交互', () => {
  test('summary 键盘开合分区（Enter/Space）', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const summary = page.locator('details > summary', { hasText: '事件流' }).first()
    const details = summary.locator('..')
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(details).not.toHaveAttribute('open', '')
    await page.keyboard.press('Space')
    await expect(details).toHaveAttribute('open', '')
  })

  test('卡片 summary 键盘开合', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const summary = tile(page, 'cpu').locator('summary')
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(tile(page, 'cpu')).toHaveAttribute('open', '')
    await page.keyboard.press('Space')
    await expect(tile(page, 'cpu')).not.toHaveAttribute('open', '')
  })

  test('反馈按钮聚焦可见并回报 signal.id', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'rapid-change', 'light')
    const fb = page.getByRole('button', { name: '噪音' }).first()
    const wrap = fb.locator('..')
    // 细指针默认：反馈容器完全透明且不吃点击
    expect(
      await wrap.evaluate((el) => getComputedStyle(el).opacity),
    ).toBe('0')
    // 键盘 Tab 到反馈按钮：focus-within 显现 + 焦点环可见
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab')
      const hit = await page.evaluate(() => {
        const l = document.activeElement?.getAttribute('aria-label')
        return l === '有用' || l === '噪音'
      })
      if (hit) break
    }
    await page.waitForTimeout(200)
    expect(
      Number(await wrap.evaluate((el) => getComputedStyle(el).opacity)),
    ).toBe(1)
    const outline = await page.evaluate(
      () =>
        getComputedStyle(document.activeElement as HTMLElement).outlineStyle,
    )
    expect(outline).toBe('solid')
    await fb.click()
    await expect(fb).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.demoAction')).toContainText('反馈噪音 sig-1')
  })

  test('反馈与原因行同高，320/420 无横向溢出', async ({ page }) => {
    for (const width of [420, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await open(page, 'rapid-change', 'light')
      const ev = page.locator('li[data-feedback]').first()
      await expect(ev).toBeVisible()
      const tops = await ev.evaluate((el) => {
        const why = el
          .querySelector('[class*="why"]')!
          .getBoundingClientRect()
        const fb = el
          .querySelector('[class*="feedback"]')!
          .getBoundingClientRect()
        return { whyTop: why.top, fbTop: fb.top }
      })
      expect(Math.abs(tops.whyTop - tops.fbTop)).toBeLessThanOrEqual(2)
      await expectNoOverflow(page)
    }
  })

  test('卡片「调整」入口打开规则分区并聚焦调整日志', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'rapid-change', 'light')
    const mem = await openTile(page, 'memory')
    await mem.getByRole('button', { name: '调整' }).click()
    const rulesSummary = page.locator('details > summary', { hasText: '规则' })
    await expect(rulesSummary.locator('..')).toHaveAttribute('open', '')
    await expect(
      page.getByRole('button', { name: '调整日志' }),
    ).toHaveAttribute('aria-pressed', 'true')
    const focused = await page.evaluate(
      () => document.activeElement?.textContent ?? '',
    )
    expect(focused).toContain('采样间隔')
    // 已在调整视图时，第二次点其他卡片的「调整」仍重新聚焦
    await tile(page, 'cpu').locator('summary').focus()
    const cpuTile = await openTile(page, 'cpu')
    await cpuTile.getByRole('button', { name: '调整' }).click()
    const focused2 = await page.evaluate(
      () => document.activeElement?.textContent ?? '',
    )
    expect(focused2).toContain('采样间隔')
    await expect(rulesSummary.locator('..')).toHaveAttribute('open', '')
  })

  test('回调生效：确认待确认规则 / 暂停 / 隐藏标题', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')

    await openSection(page, '规则')
    await page.getByRole('button', { name: '确认' }).click()
    await expect(page.getByText('待确认')).toHaveCount(0)
    await expect(page.getByText('确认规则 rule-pending')).toBeVisible()

    await page.locator('label', { hasText: '窗口标题发给模型' }).locator('input').click()
    await expect(page.getByText('标题已隐藏', { exact: true })).toBeVisible()

    await page.locator('label', { hasText: '暂停感知' }).locator('input').click()
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible()
  })

  test('实时模式数值会更新，关闭后停住', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    await page.locator('label', { hasText: '实时模式' }).locator('input').check()
    const cell = tile(page, 'cpu').locator('summary').first()
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
    const cell = tile(page, 'cpu').locator('summary').first()
    await page.waitForTimeout(1_400)
    await openSection(page, '规则')
    await page.locator('label', { hasText: '暂停感知' }).locator('input').check()
    const paused = await cell.innerText()
    await page.waitForTimeout(1_600)
    expect(await cell.innerText()).toBe(paused)
    await page.locator('label', { hasText: '暂停感知' }).locator('input').uncheck()
    await page.waitForTimeout(1_400)
    expect(await cell.innerText()).not.toBe(paused)
  })

  test('规则分区打开状态下的 axe 与调参联动', async ({ page }) => {
    const errors = watchErrors(page)
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'rapid-change', 'light')
    await openSection(page, '规则')
    await page.getByRole('button', { name: '调整日志' }).click()
    await axeCheck(page)
    // 锁定/解锁 CPU 异常灵敏度
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
    await expect(page.getByText('3 σ', { exact: true }).first()).toBeVisible()
    expect(errors).toEqual([])
  })

  test('位置与信号源明细展开时的 axe（明暗双主题）', async ({ page }) => {
    const errors = watchErrors(page)
    for (const theme of THEMES) {
      await page.setViewportSize({ width: 420, height: 900 })
      await open(page, 'healthy', theme)
      // healthy 位置合并为「全部在」；信号源为独立 details
      await openSection(page, '全部在')
      await openSection(page, '信号源')
      await axeCheck(page)
    }
    expect(errors).toEqual([])
  })

  test('过期保留值灰显并明确标注已过期', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'permission-denied', 'light')
    const stale = page.locator('[class*="factStale"]').first()
    await expect(stale).toContainText('已过期')
    await expect(stale).toContainText('120 秒前')
    const filter = await stale.evaluate(
      (el) => getComputedStyle(el).filter,
    )
    expect(filter).toContain('grayscale')
  })
})

test.describe('容量未确认（fallback 上下文窗口）', () => {
  for (const theme of THEMES) {
    test(`token-fallback 420 ${theme} 截图与降饱和`, async ({ page }) => {
      const errors = watchErrors(page)
      await page.setViewportSize({ width: 420, height: 900 })
      await open(page, 'token-fallback', theme)
      const t = tile(page, 'tokens')
      await expect(t).toContainText('容量未确认')
      await expect(t).not.toContainText('剩余')
      await expect(t).not.toContainText('按当前速度')
      // 环标记未确认，告警徽标不出现
      await expect(t.locator('svg[data-unconfirmed]')).toHaveCount(1)
      await expect(t.locator('[class*="sevTag"][data-sev="warn"]')).toHaveCount(0)
      await axeCheck(page)
      await expect(page).toHaveScreenshot(`token-fallback-420-${theme}.png`, { fullPage: true })
      expect(errors).toEqual([])
    })
  }
})

test.describe('磁盘卷级状态（disk-partial，420px × 明暗）', () => {
  for (const theme of THEMES) {
    test(`disk-partial 420 ${theme}：根卷过期灰显 / 网络盘无法读取 / 新鲜卷仍良好`, async ({
      page,
    }) => {
      const errors = watchErrors(page)
      await page.setViewportSize({ width: 420, height: 900 })
      await open(page, 'disk-partial', theme)
      const t = tile(page, 'disks')
      // /data 新鲜 → 行仍良好；根卷失鲜+不可读盘只加「部分」标记
      await expect(t).toHaveAttribute('data-sev', 'good')
      await expect(t.locator('summary [data-partial]')).toContainText(
        '部分 · 数据待补全',
      )
      // 总览：严重度词旁「部分」徽标 + 部分补全句
      await expect(
        page.locator('[class*="monitorPartial"]'),
      ).toContainText('部分')
      await expect(
        page.locator('[class*="monitorSub"]').first(),
      ).toContainText('数据待补全')
      // 主摘要为根卷过期保留值（灰显 + 年龄）
      const summary = t.locator('summary')
      await expect(summary.locator('[data-status="stale"]').first()).toBeVisible()
      await expect(summary).toContainText('已过期 · 90 秒前')
      await expect(summary).toContainText('163.0 GB')
      // 展开：根卷 stale 块、/data 当前读数、网络盘无法读取无数字无图
      await openTile(page, 'disks')
      const rootBlock = t.locator('[data-metric="disk:/"]')
      await expect(rootBlock).toContainText('上次读数')
      await expect(rootBlock).toContainText('已过期')
      await expect(t.locator('[data-metric="disk:/data"]')).toContainText('149.0 GB')
      const netRow = t.locator('[class*="detailLine"]', { hasText: '/Volumes/network' })
      await expect(netRow).toContainText('无法读取')
      await expect(netRow).not.toContainText('GB')
      await expect(
        t.locator('[data-metric="disk:/Volumes/network"]'),
      ).toHaveCount(0)
      await expectNoOverflow(page)
      await axeCheck(page)
      await expect(page).toHaveScreenshot(`disk-partial-420-${theme}.png`, { fullPage: true })
      expect(errors).toEqual([])
    })
  }
})

test.describe('修复验收：网格末位与阈值图', () => {
  // 每个卡片矩形：key/top/width；grid 宽用于跨行判断
  const tilesRect = (page: Page) =>
    page.evaluate(() => {
      const gw = document.querySelector('div[class*="tiles"]')!.getBoundingClientRect().width
      return [...document.querySelectorAll<HTMLElement>('div[class*="tiles"] > [class*="tile"]')]
        .map((el) => {
          const r = el.getBoundingClientRect()
          return { key: el.getAttribute('data-tile'), top: Math.round(r.top), w: r.width, gw }
        })
    })

  // 末位是否单独成行只看最后一个整行卡之后的尾部序列
  for (const c of [
    { name: 'healthy', openKey: '', lastSpans: true, pairWith: '' },
    { name: 'desktop-no-battery', openKey: '', lastSpans: false, pairWith: 'thermal' },
    { name: 'healthy 展开 cpu', openKey: 'cpu', lastSpans: true, pairWith: '' },
    { name: 'healthy 展开 disks', openKey: 'disks', lastSpans: false, pairWith: 'battery' },
    { name: 'healthy 展开 network', openKey: 'network', lastSpans: true, pairWith: '' },
  ]) {
    test(`末位配对：${c.name}`, async ({ page }) => {
      await page.setViewportSize({ width: 420, height: 900 })
      await open(page, c.name.split(' ')[0]!, 'light')
      if (c.openKey) await openTile(page, c.openKey)
      const rects = await tilesRect(page)
      const last = rects[rects.length - 1]!
      expect(last.key).toBe('process')
      if (c.lastSpans) {
        expect(last.w).toBeGreaterThan(last.gw - 8)
      } else {
        expect(last.w).toBeLessThan(last.gw * 0.6)
        expect(last.top).toBe(rects.find((r) => r.key === c.pairWith)!.top)
      }
    })
  }
  test('展开明细：告警线为虚线、严重线为实线且不与标签重叠', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'rapid-change', 'light')
    const t = await openTile(page, 'disks')
    // 末点当前状态标记 + 无障碍摘要含当前状态
    await expect(t.locator('circle[data-current]').first()).toHaveCount(1)
    expect(await t.locator('[class*="srOnly"]').first().textContent()).toContain('当前状态')
    const lines = await t.locator('line[data-threshold]').evaluateAll((els) =>
      els.map((el) => ({
        sev: el.getAttribute('data-threshold'),
        dash: getComputedStyle(el).strokeDasharray,
        opacity: getComputedStyle(el).opacity,
      })),
    )
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(Number(l.opacity)).toBeGreaterThanOrEqual(0.99)
      if (l.sev === 'warn') expect(l.dash).not.toBe('none')
      if (l.sev === 'critical') expect(l.dash).toBe('none')
    }
    // 阈值标签互不重叠（≥2 个标签时逐一比对）
    const labels = await t.locator('span[class*="thrLabel"]').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
    )
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue
        const overlap = !(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left)
        expect(overlap).toBe(false)
      }
    }
  })

  test('阈值线与面板背景对比度 ≥3，证据写 test-results', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'rapid-change', 'light')
    const t = await openTile(page, 'disks')
    const ratios = await t.evaluate(() => {
      // CSS 颜色（含 color(srgb …)）经 1x1 canvas 归一为 [r,g,b,a]
      const cv = document.createElement('canvas')
      cv.width = cv.height = 1
      const cx = cv.getContext('2d')!
      const norm = (cssColor: string) => {
        cx.clearRect(0, 0, 1, 1)
        cx.fillStyle = cssColor
        cx.fillRect(0, 0, 1, 1)
        return [...cx.getImageData(0, 0, 1, 1).data] as number[]
      }
      const lum = ([r, g, b]: number[]) => {
        const lin = (c: number) => {
          const s = c / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
      }
      const bg = norm(getComputedStyle(document.querySelector('[data-panel]')!).backgroundColor)
      const out: Record<string, { stroke: number[]; ratio: number }> = {}
      for (const el of document.querySelectorAll('line[data-threshold]')) {
        const sev = el.getAttribute('data-threshold')!
        const stroke = norm(getComputedStyle(el).stroke)
        const L1 = Math.max(lum(stroke), lum(bg))
        const L2 = Math.min(lum(stroke), lum(bg))
        out[sev] = { stroke, ratio: (L1 + 0.05) / (L2 + 0.05) }
      }
      return { bg, out }
    })
    expect(ratios.bg[3]).toBe(255)
    expect(Object.keys(ratios.out).length).toBeGreaterThan(0)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'threshold-contrast.json'),
      JSON.stringify(ratios, null, 2),
    )
    for (const [sev, r] of Object.entries(ratios.out)) {
      expect(r.ratio, `${sev} 阈值线对比度`).toBeGreaterThanOrEqual(3)
    }
  })

})

test.describe('标注底色不透明（y 轴/明细标签/剩余条）', () => {
  test('展开磁盘明细：y 轴极值、已用率标签、剩余条标签底色 alpha=1', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await open(page, 'healthy', 'light')
    const t = await openTile(page, 'disks')
    const bgAlpha = (loc: ReturnType<Page['locator']>) =>
      loc.first().evaluate((el) => {
        const s = getComputedStyle(el).backgroundColor
        const m = s.match(/[\d.]+/g)
        return m && m.length >= 4 ? parseFloat(m[3]!) : 1
      })
    // y 轴极值标签（展开图内）
    expect(await bgAlpha(t.locator('[class*="axisYMax"]'))).toBe(1)
    expect(await bgAlpha(t.locator('[class*="axisYMin"]'))).toBe(1)
    // 明细指标名「磁盘 / 已用率」与剩余条可见标签
    expect(
      await bgAlpha(t.locator('[class*="metricName"]', { hasText: '已用率' })),
    ).toBe(1)
    expect(
      await bgAlpha(t.locator('[class*="stripText"]', { hasText: '剩余' })),
    ).toBe(1)
  })
})
