/**
 * Autonomous UI agent functional test script
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = 'http://localhost:5173'
const results = { console_errors: [] }

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function closePanel(page) {
  const backdrop = page.locator('.panel-backdrop')
  if (await backdrop.isVisible().catch(() => false)) {
    await backdrop.click()
    await sleep(400)
  }
}

async function main() {
  mkdirSync('scripts/screenshots', { recursive: true })
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('console', (msg) => {
    if (msg.type() === 'error') results.console_errors.push(msg.text())
  })
  page.on('pageerror', (err) => results.console_errors.push(err.message))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.screenshot({ path: 'scripts/screenshots/baseline.png', fullPage: true })

  results.brain_dump_has_content = (await page.locator('textarea').first().inputValue()).length > 0

  await page.locator('input[type="password"]').fill('demo')
  results.api_key_set = true

  await page.getByRole('button', { name: /AI plan/i }).click()
  await sleep(3500)

  const blockCards = page.locator('.block-card')
  await blockCards.first().waitFor({ timeout: 8000 }).catch(() => {})
  results.blocks_after_plan = await blockCards.count()
  results.ai_planning_works = results.blocks_after_plan > 0
  results.detail_panel_visible = await page.locator('[data-testid="detail-panel"]').isVisible()

  await page.screenshot({ path: 'scripts/screenshots/after-plan.png', fullPage: true })

  const target = page.locator('.block-card').filter({ hasNot: page.getByText('Open time', { exact: true }) }).first()
  if (results.blocks_after_plan > 0 && (await target.count()) > 0) {
    const tbox = await target.boundingBox()
    if (tbox) await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + 28)
    await sleep(900)
    results.detail_panel_switches = (await page.locator('[data-testid="detail-panel"]').count()) > 0
    await page.screenshot({ path: 'scripts/screenshots/detail-panel.png', fullPage: true })
    await closePanel(page)
  }

  // Drag
  if (results.blocks_after_plan > 0 && (await target.count()) > 0) {
    const box = await target.boundingBox()
    if (box) {
      const before = await target.locator('.block-meta-text').textContent()
      await page.mouse.move(box.x + box.width / 2, box.y + 40)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 15 })
      await page.mouse.up()
      await sleep(1000)
      const after = await target.locator('.block-meta-text').textContent()
      results.drag_changed_time = before !== after
    }
  }

  results.task_panel_visible = await page.locator('.task-list-panel').isVisible()
  results.task_count = await page.locator('.task-list-panel .text-xs.flex-1').count()
  const firstTask = page.locator('.task-list-panel .text-xs.flex-1').first()
  if ((await firstTask.count()) > 0) {
    await firstTask.click()
    await sleep(300)
    results.task_checkbox_works = await page.evaluate(() => {
      const row = document.querySelector('.task-list-panel .text-xs.flex-1')
      return row?.style.textDecoration === 'line-through'
    })
  }
  results.now_line_visible = await page.locator('.now-line-row').isVisible()
  results.open_time_blocks = await page.locator('.block-card', { hasText: 'Open time' }).count()

  await closePanel(page)

  // Replan
  await page.getByRole('button', { name: 'Something came up' }).click()
  await sleep(400)
  const textareas = page.locator('textarea')
  if ((await textareas.count()) >= 3) {
    await textareas.nth(1).fill('Meeting ran long')
    await textareas.nth(2).fill('Still need flashcards')
  }
  await page.getByRole('button', { name: 'Replan remaining day' }).click()
  await sleep(2500)
  results.crossed_out_blocks = await page.locator('.block-crossed').count()
  results.replan_flow = results.crossed_out_blocks > 0
  await page.screenshot({ path: 'scripts/screenshots/after-replan.png', fullPage: true })

  await closePanel(page)

  // Keyboard — use a non-crossed block after replan
  const activeBlock = page.locator('.block-card:not(.block-crossed)').filter({ hasNot: page.getByText('Open time', { exact: true }) }).first()
  if ((await activeBlock.count()) > 0) {
    await activeBlock.click()
    await sleep(400)
    const wasDone = await activeBlock.evaluate((el) => el.classList.contains('block-done'))
    await page.keyboard.press('Space')
    await sleep(500)
    const isDone = await activeBlock.evaluate((el) => el.classList.contains('block-done'))
    results.keyboard_shortcut = wasDone !== isDone
  }

  results.reflection_visible = await page.getByText('How did it go?').isVisible()

  // Manual mode - reload fresh
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="password"]').fill('demo')
  await page.getByRole('button', { name: /Manual/i }).click()
  await sleep(800)
  const timeline = page.locator('.relative.cursor-crosshair, .relative').nth(1)
  const tbox = await timeline.boundingBox()
  if (tbox) {
    const beforeManual = await page.locator('.block-card').count()
    await page.mouse.click(tbox.x + 80, tbox.y + 120)
    await sleep(600)
    const afterManual = await page.locator('.block-card').count()
    results.manual_mode_adds_block = afterManual > beforeManual
  }

  await page.screenshot({ path: 'scripts/screenshots/final.png', fullPage: true })
  await browser.close()
  console.log(JSON.stringify(results, null, 2))
}

main().catch((err) => {
  console.error('TEST_FAILED:', err.message)
  process.exit(1)
})
