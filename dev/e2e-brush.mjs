/**
 * Manual design: free-form brush in Crown Studio, desktop, against the
 * production build. Loads the demo case, turns the brush on, drags across the
 * crown, and checks that the stroke is re-checked, changes the crown's
 * volume, and can be undone.   node dev/e2e-brush.mjs <screenshotDir>
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const { chromium } = createRequire(import.meta.url)('playwright')
const out = process.argv[2] ?? '.'
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC')))
const server = spawn('node', ['server/index.mjs'], { env: { ...env, PORT: '8797' }, stdio: 'pipe' })
await new Promise((r) => server.stdout.once('data', r))
const fail = (m) => { console.error('E2E FAIL:', m); server.kill(); process.exit(1) }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
await ctx.addInitScript(() => localStorage.setItem('saycad.pro', '1'))
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))
await page.route('**/api/health', (r) => r.fulfill({ json: { ai: false, needsCode: false } }))

await page.goto('http://localhost:8797/?e2e')
await page.getByRole('button', { name: 'Try the Demo Case' }).click()
await page.waitForSelector('.st-verdict', { timeout: 180000 })
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 180000 })
await page.locator('.st-rail-item', { hasText: 'Adapt' }).click()
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 180000 })
const volume = async () => Number((await page.locator('.st-foot', { hasText: 'mm³' }).last().innerText()).match(/([\d.]+) mm³/)[1])
const v0 = await volume()
console.log('volume before:', v0)

await page.getByRole('checkbox', { name: 'Brush' }).check({ force: true })
await page.getByRole('button', { name: 'Add', exact: true }).click()
await page.getByRole('button', { name: 'occlusal view' }).click()
await page.waitForTimeout(800)

// Drag across the middle of the visible stage, where the crown is drawn.
const at = await page.evaluate(() => window.__saycadViewport.crownScreenPoint())
const cx = at.x
const cy = at.y
await page.screenshot({ path: `${out}/brush-0-before.png` })
console.log('brush on:', await page.getByRole('checkbox', { name: 'Brush' }).isChecked(), 'drag at', cx, cy)
const stroke = async () => {
  await page.mouse.move(cx - 30, cy)
  await page.mouse.down()
  for (let k = 0; k <= 20; k++) await page.mouse.move(cx - 30 + k * 3, cy + Math.sin(k / 3) * 6)
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('.st-brush-note')?.textContent?.startsWith('Edited'), null, { timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: `${out}/brush-fail.png` }); console.log('status:', await page.locator('.st-brush-note').innerText().catch(() => '?')); throw e })
}
await stroke()
await page.waitForTimeout(300)
const v1 = await volume()
console.log('after add stroke:', await page.locator('.st-brush-note').innerText(), 'volume', v1)
await page.screenshot({ path: `${out}/brush-1-added.png` })
if (!(v1 > v0 + 0.05)) fail(`add stroke did not add material (${v0} → ${v1})`)

await page.getByRole('button', { name: 'Undo Stroke' }).click()
await page.waitForFunction(() => document.querySelector('.st-brush-note')?.textContent?.includes('undone'), null, { timeout: 60000 })
await page.waitForTimeout(300)
const v2 = await volume()
console.log('after undo: volume', v2)
if (Math.abs(v2 - v0) > 0.05) fail(`undo did not restore the volume (${v0} → ${v2})`)

await page.getByRole('button', { name: 'Smooth', exact: true }).click()
await stroke()
console.log('after smooth stroke:', await page.locator('.st-brush-note').innerText())
await page.screenshot({ path: `${out}/brush-2-smoothed.png` })

console.log('E2E BRUSH OK')
await browser.close()
server.kill()
