/**
 * Real-scan run of the New Crown flow (local only: real cases live in the
 * git-ignored dev/cases/<case>/ and never leave this machine).
 *
 *   npm run build && node dev/e2e-real.mjs <outDir> [case=laura] [tooth=13] [prepScan=JawUpper] [opposingScan=JawLower]
 *
 * Records what the app does with real data — which is the point: where the
 * engine is unsure it must say so (pins, review cards), not guess.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
const { chromium, devices } = createRequire(import.meta.url)('playwright')

const [out = 'e2e-out', name = 'laura', tooth = '13', prepScan = 'JawUpper', oppScan = 'JawLower'] = process.argv.slice(2)
const dir = join('dev/cases', name)
const prep = join(dir, `${prepScan}.stl`)
const opp = join(dir, `${oppScan}.stl`)
if (!existsSync(prep) || !existsSync(opp)) {
  console.log(`skip: ${dir} not on this machine (real cases are local only)`)
  process.exit(0)
}
const server = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: '8791' }, stdio: 'pipe' })
process.on('exit', () => server.kill())
await new Promise((r) => server.stdout.once('data', r))
const browser = await chromium.launch()
const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage()
const shot = (n) => page.screenshot({ path: join(out, `real-${n}.png`) })
const choose = async (button, file) => {
  const [c] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: button }).click()])
  await c.setFiles([file])
}

await page.goto('http://localhost:8791/')
await page.getByRole('button', { name: 'New Crown', exact: true }).click()
await page.getByRole('button', { name: `Tooth ${tooth}`, exact: true }).click()
await page.getByRole('button', { name: 'Continue' }).click()
const jawTitle = await page.locator('.nc-card[aria-hidden="false"] h1').innerText()
await choose(`Choose ${jawTitle}`, prep)
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '3/3', null, { timeout: 60000 })
const oppTitle = await page.locator('.nc-card[aria-hidden="false"] h1').innerText()
await choose(`Choose ${oppTitle}`, opp)
await page.waitForFunction(() => document.querySelectorAll('.nc-card[aria-hidden="false"] .nc-file-main').length > 0, null, { timeout: 60000 })
const intake = await page.locator('.nc-card .nc-file-main span').allInnerTexts()
console.log(`intake: ${jawTitle}: ${intake[0]} | ${oppTitle}: ${intake[1]}`)
const warn = await page.locator('.nc-warn').allInnerTexts()
if (warn.length) console.log('intake warnings:', warn.join(' | '))
await shot('1-scans')
const t0 = Date.now()
await page.getByRole('button', { name: 'Design Crown' }).click()
// Either a design (review deck) or a question (numbered pins / tap prompt).
await page.waitForFunction(() => document.querySelector('.rv') || document.querySelector('.st-pin') || /Several teeth|in the bite|stands out|opposing scan/i.test(document.querySelector('.st-status')?.textContent ?? ''), null, { timeout: 180000 })
await page.waitForTimeout(800)
const status = await page.locator('.st-status').innerText()
const pins = await page.locator('.st-pin').count()
console.log(`after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${pins ? `${pins} pins — ` : ''}${status}`)
await shot('2-ask')
if (pins) {
  await page.locator('.st-pin').first().click()
  await page.waitForFunction(() => document.querySelector('.rv') || document.querySelector('.st-runrow.fail'), null, { timeout: 180000 })
  await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
  await page.waitForTimeout(800)
}
const failed = await page.locator('.st-runrow.fail').allInnerTexts()
if (failed.length) console.log('design run stopped:', failed.join(' | ').replace(/\s+/g, ' '))
await shot('3-result')
if (await page.locator('.rv').count()) {
  console.log('review deck:', (await page.locator('.rv').innerText()).replace(/\s+/g, ' ').slice(0, 400))
  await shot('3-review')
}
await browser.close()
process.exit(0)
