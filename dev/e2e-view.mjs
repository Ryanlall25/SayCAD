/**
 * View controls in Crown Studio, desktop, against the production build: the
 * prep jaw and opposing jaw cycle solid → see-through → hidden, taps still
 * reach a see-through jaw, and the side labels sit on the correct sides.
 *   npm run build && node dev/e2e-view.mjs [outDir]
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const { chromium } = createRequire(import.meta.url)('playwright')
const out = process.argv[2] ?? 'e2e-out'
mkdirSync(out, { recursive: true })
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC')))
const server = spawn('node', ['server/index.mjs'], { env: { ...env, PORT: '8797' }, stdio: 'pipe' })
process.on('exit', () => server.kill())
await new Promise((r) => server.stdout.once('data', r))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
await ctx.addInitScript(() => localStorage.setItem('saycad.pro', '1'))
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))
await page.route('**/api/health', (r) => r.fulfill({ json: { ai: false, needsCode: false } }))
const fail = async (m) => { console.error('E2E FAIL:', m); await page.screenshot({ path: join(out, 'view-fail.png') }).catch(() => {}); await browser.close(); server.kill(); process.exit(1) }

await page.goto('http://localhost:8797/?e2e')
await page.getByRole('button', { name: 'Try the Demo Case' }).click()
await page.waitForSelector('.st-verdict', { timeout: 180000 })
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 180000 })
const look = (layer) => page.evaluate((l) => window.__saycadViewport.look(l), layer)

// Prep jaw: solid → see-through → hidden → solid.
const jaw = page.getByRole('button', { name: /^Prep jaw:/ })
const seen = [await look('scan')]
for (let k = 0; k < 3; k++) { await jaw.click(); seen.push(await look('scan')) }
console.log('prep jaw looks:', seen.join(' → '))
if (seen.join() !== 'solid,ghost,hidden,solid') await fail(`prep jaw cycle was ${seen.join(' → ')}`)
await jaw.click()
await page.getByRole('button', { name: 'occlusal view' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: join(out, 'view-jaw-ghost.png') })
// A see-through jaw still takes taps: the scan is hit under the crown's neighbour area.
const hitsScan = await page.evaluate(() => {
  const v = window.__saycadViewport
  const c = v.crownScreenPoint()
  // Beside the crown: a neighbouring tooth on the see-through jaw.
  for (const dx of [140, -140, 200, -200]) { const h = v.pick(c.x + dx, c.y); if (h) return h.target }
  return null
})
console.log('pick on see-through jaw:', hitsScan)
if (hitsScan !== 'scan') await fail(`a tap on the see-through jaw hit ${hitsScan}`)

// Opposing jaw starts see-through, then hidden, solid.
const opp = page.getByRole('button', { name: /^Opposing jaw:/ })
const o = [await look('antagonist')]
for (let k = 0; k < 3; k++) { await opp.click(); o.push(await look('antagonist')) }
console.log('opposing jaw looks:', o.join(' → '))
if (o.join() !== 'ghost,hidden,solid,ghost') await fail(`opposing jaw cycle was ${o.join(' → ')}`)

// Side labels: buccal and lingual on opposite sides of the crown, mesial and distal too.
await page.getByRole('button', { name: 'buccal view' }).click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'occlusal view' }).click()
await page.waitForTimeout(800)
const L = await page.evaluate(() => window.__saycadViewport.orientLabelScreen())
const c = await page.evaluate(() => window.__saycadViewport.crownScreenPoint())
console.log('side labels:', Object.entries(L).map(([k, p]) => `${k} ${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' · '), '· crown', c.x.toFixed(0), c.y.toFixed(0))
const opposite = (a, b) => ((L[a].x - c.x) * (L[b].x - c.x) + (L[a].y - c.y) * (L[b].y - c.y)) < 0
if (!['Buccal', 'Lingual', 'Mesial', 'Distal'].every((k) => L[k])) await fail('a side label is missing')
if (!opposite('Buccal', 'Lingual') || !opposite('Mesial', 'Distal')) await fail('side labels are not on opposite sides of the crown')
await page.screenshot({ path: join(out, 'view-sides.png') })
await page.getByRole('button', { name: /^Side labels on/ }).click()
if (await page.evaluate(() => window.__saycadViewport.orientLabelsOn)) await fail('side labels did not turn off')

console.log('E2E VIEW OK')
await browser.close()
server.kill()
