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

// Grab: press on the crown and drag up the screen.
await page.getByRole('button', { name: 'Grab', exact: true }).click()
const g0 = await volume()
const note0 = await page.locator('.st-brush-note').innerText()
const strokes0 = await page.evaluate(() => window.__saycadViewport.strokesDone)
await page.mouse.move(cx, cy)
await page.mouse.down()
for (let k = 1; k <= 10; k++) await page.mouse.move(cx, cy - k * 2)
await page.mouse.up()
await page.waitForFunction(([n0, s0]) => window.__saycadViewport.strokesDone > s0 && document.querySelector('.st-brush-note')?.textContent !== n0, [note0, strokes0], { timeout: 30000 })
await page.waitForTimeout(300)
console.log('after grab:', await page.locator('.st-brush-note').innerText())
await page.screenshot({ path: `${out}/brush-3-grab.png` })
if (Math.abs((await volume()) - g0) < 0.05) fail('grab did not change the crown')

// Brush edits survive a design-setting change: add a bump, change the occlusal clearance, the bump stays.
await page.getByRole('button', { name: 'Add', exact: true }).click()
const kBefore = await page.evaluate(() => window.__saycadViewport.strokesDone)
await page.mouse.move(cx - 30, cy); await page.mouse.down()
for (let k = 0; k <= 20; k++) await page.mouse.move(cx - 30 + k * 3, cy)
await page.mouse.up()
await page.waitForFunction((k0) => window.__saycadViewport.strokesDone > k0, kBefore, { timeout: 30000 })
await page.waitForFunction(() => document.querySelector('.st-brush-note')?.textContent?.startsWith('Edited'), null, { timeout: 30000 })
await page.waitForTimeout(500)
const vEdited = await volume()
await page.getByRole('button', { name: 'Discard Brush Edits' }).waitFor({ timeout: 10000 })
const clearance = page.locator('.st-slider', { hasText: 'Occlusal clearance' }).locator('input')
await clearance.fill('0.12')
await page.waitForFunction(() => document.querySelector('.st-status')?.textContent?.includes('Brush edits kept') || !!document.querySelector('.st-status'), null, { timeout: 60000 })
await page.waitForTimeout(4000)
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
const vAfter = await volume()
console.log(`edit kept across redesign: volume edited ${vEdited} → after clearance change ${vAfter}`)
await page.getByRole('button', { name: 'Discard Brush Edits' }).click()
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
await page.waitForTimeout(4000)
const vPlain = await volume()
console.log(`after discarding edits: volume ${vPlain}`)
// The saved edits (grab + add) changed the volume by vEdited − v0 on the original design;
// re-applied after the redesign they should change it by about as much.
const want = vEdited - v0, got = vAfter - vPlain
console.log(`edits' volume effect: ${want.toFixed(1)} before the redesign, ${got.toFixed(1)} after`)
if (Math.abs(got - want) > 0.3 || Math.abs(got) < 0.2) fail(`brush edits were not kept across the redesign (${want.toFixed(2)} vs ${got.toFixed(2)})`)

// Distance maps.
for (const m of ['Occlusion', 'Contacts']) {
  await page.getByRole('group', { name: 'Distance map' }).getByRole('button', { name: m }).click()
  await page.waitForTimeout(300)
  const coloured = await page.evaluate(() => {
    const v = window.__saycadViewport
    const g = v.design[v.currentMap === 'occlusion' ? 'occlusalGap' : 'proximalGap']
    return Array.from(g).filter(Number.isFinite).length
  })
  console.log(`${m} map: ${coloured} vertices with a gap value; legend: ${(await page.locator('.st-legend').innerText()).replace(/\s+/g, ' ')}`)
  if (!coloured) fail(`${m} map has no values`)
  await page.screenshot({ path: `${out}/map-${m.toLowerCase()}.png` })
}

// Margin: drag a point of the line on the scan; the crown is redesigned to it.
await page.locator('.st-rail-item', { hasText: 'Margin' }).click()
await page.getByRole('button', { name: 'Adjust', exact: true }).click()
await page.getByRole('button', { name: 'occlusal view' }).click()
await page.waitForTimeout(800)
const m0 = await page.evaluate(() => window.__saycadViewport.marginPts.points.map((p) => [...p]))
const mp = await page.evaluate(() => window.__saycadViewport.marginScreenPoint(0))
await page.mouse.move(mp.x, mp.y)
await page.mouse.down()
for (let k = 1; k <= 8; k++) await page.mouse.move(mp.x + k * 1.5, mp.y + k * 1.5)
await page.mouse.up()
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
await page.waitForTimeout(500)
const moved = await page.evaluate((m0) => {
  const pts = window.__saycadViewport.marginPts.points
  return Math.max(...pts.map((p, i) => Math.hypot(p[0] - m0[i][0], p[1] - m0[i][1], p[2] - m0[i][2])))
}, m0)
console.log(`margin drag: line moved up to ${moved.toFixed(2)} mm`)
await page.screenshot({ path: `${out}/margin-drag.png` })
if (!(moved > 0.05)) fail('margin drag did not move the line')

console.log('E2E BRUSH OK')
await browser.close()
server.kill()
