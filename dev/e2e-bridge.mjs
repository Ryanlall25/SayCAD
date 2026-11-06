/**
 * Bridge workflow in Crown Studio, desktop, against the production build:
 * a lower jaw with two preps (#19 and #17, #18 missing), design the crown on
 * #19, choose a distal pontic, tap the second prep, design the bridge and
 * check it is one closed solid with its connectors measured.
 *
 *   npm run build && node dev/e2e-bridge.mjs <caseDir> [outDir]
 * caseDir holds bridge-lowerjaw.stl, bridge-upperjaw.stl and bridge.json
 * ({ tap1, tap2 } world points on the two preps).
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const { chromium } = createRequire(import.meta.url)('playwright')
const caseDir = process.argv[2]
const out = process.argv[3] ?? 'e2e-out'
if (!caseDir) throw new Error('usage: node dev/e2e-bridge.mjs <caseDir> [outDir]')
mkdirSync(out, { recursive: true })
const { tap1, tap2 } = JSON.parse(readFileSync(join(caseDir, 'bridge.json'), 'utf8'))

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC')))
const server = spawn('node', ['server/index.mjs'], { env: { ...env, PORT: '8797' }, stdio: 'pipe' })
process.on('exit', () => server.kill())
await new Promise((r) => server.stdout.once('data', r))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const fail = async (m) => { console.error('E2E FAIL:', m); await page.screenshot({ path: join(out, 'bridge-fail.png') }).catch(() => {}); await browser.close(); server.kill(); process.exit(1) }
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
await ctx.addInitScript(() => localStorage.setItem('saycad.pro', '1'))
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))
await page.route('**/api/health', (r) => r.fulfill({ json: { ai: false, needsCode: false } }))
async function choose(buttonName, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName }).click()])
  await chooser.setFiles(files)
}

await page.goto('http://localhost:8797/?e2e')
await page.getByRole('button', { name: 'New Crown', exact: true }).click()
await page.getByRole('button', { name: 'Tooth 19' }).click()
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent?.endsWith('/3'), null, { timeout: 30000 })
await page.getByRole('button', { name: 'Continue' }).click()
await choose('Choose Lower jaw scan', [join(caseDir, 'bridge-lowerjaw.stl')])
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '3/3', null, { timeout: 30000 })
await choose('Choose Upper jaw scan', [join(caseDir, 'bridge-upperjaw.stl')])
await page.getByRole('button', { name: 'Design Crown' }).click()
// Two preps in view: the app may ask which tooth — tap #19.
await page.waitForFunction(() => document.querySelector('.rv, .st-verdict') || /Tap the/.test(document.querySelector('.st-status')?.textContent ?? ''), null, { timeout: 180000 })
if (!(await page.locator('.rv, .st-verdict').count())) {
  console.log('asked:', await page.locator('.st-status').innerText())
  await page.waitForTimeout(800)
  const p1 = await page.evaluate((p) => window.__saycadViewport.worldToScreen(p), tap1)
  await page.mouse.click(p1.x, p1.y)
}
await page.waitForSelector('.rv, .st-verdict', { timeout: 180000 }).catch(async () => fail('no design: ' + (await page.locator('.st-status').innerText().catch(() => '?'))))
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 180000 })
if (await page.getByRole('button', { name: 'Adjust Design' }).count()) await page.getByRole('button', { name: 'Adjust Design' }).click()
await page.locator('.st-rail-item', { hasText: 'Adapt' }).click()
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 180000 })
console.log('crown designed on #19')

const side = page.getByRole('group', { name: 'Pontic side' }).getByRole('button', { name: 'Pontic 37, abutment 38' })
if (!(await side.count())) await fail('no distal bridge option for #19 (FDI 36)')
await side.click()
await page.getByRole('button', { name: 'occlusal view' }).click()
await page.waitForTimeout(800)
const at = await page.evaluate((p) => window.__saycadViewport.worldToScreen(p), tap2)
console.log('tapping second prep at', at)
await page.mouse.click(at.x, at.y)
await page.waitForFunction(() => document.querySelector('.st-bridge-note')?.textContent?.includes('Second abutment found') || document.querySelector('.st-bridge-note')?.textContent?.match(/not|fail|error/i), null, { timeout: 60000 })
const picked = await page.locator('.st-bridge-note').innerText()
console.log('pick:', picked)
if (!picked.includes('Second abutment found')) await fail(`second abutment not found: ${picked}`)
await page.screenshot({ path: join(out, 'bridge-1-picked.png') })

const t0 = Date.now()
await page.getByRole('button', { name: 'Design Bridge' }).click()
await page.waitForSelector('.st-bridge-report', { timeout: 240000 }).catch(async () => fail(`no bridge report: ${await page.locator('.st-bridge-note').innerText().catch(() => '?')}`))
const report = (await page.locator('.st-bridge-report').innerText()).replace(/\s+/g, ' ')
console.log(`bridge in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, report, '|', await page.locator('.st-bridge-note').innerText())
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'bridge-2-designed.png') })
if (!report.includes('One closed solid')) await fail('bridge is not one closed solid')
if ((report.match(/Connector/g) ?? []).length !== 2) await fail('expected two connectors')
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Bridge STL' }).click()])
console.log('download:', download.suggestedFilename())
if (!/^bridge_36-38_.*\.stl$/.test(download.suggestedFilename())) await fail('unexpected bridge file name')
await page.getByRole('button', { name: 'Cancel Bridge' }).click()
if (await page.locator('.st-bridge-report').count()) await fail('Cancel Bridge left the report up')

console.log('E2E BRIDGE OK')
await browser.close()
server.kill()
