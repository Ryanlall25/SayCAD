/**
 * End-to-end check of Crown Studio on a phone-sized viewport, against the
 * production build served by server/index.mjs. The Claude endpoints are
 * stubbed (no API key needed) so the AI tool loop is exercised for real on
 * the client side.  node dev/e2e.mjs <screenshotDir>
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const out = process.argv[2] ?? '.'
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC')))
const server = spawn('node', ['server/index.mjs'], { env: { ...env, PORT: '8799' }, stdio: 'pipe' })
await new Promise((r) => server.stdout.once('data', r))
const fail = (m) => { console.error('E2E FAIL:', m); server.kill(); process.exit(1) }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))

// Stub the AI server: one tool round (tighten distal contact + read checks), then a reply.
let assistCalls = 0
await page.route('**/api/health', (r) => r.fulfill({ json: { ai: true, needsCode: false, model: 'stub' } }))
await page.route('**/api/assist', async (r) => {
  const body = r.request().postDataJSON()
  assistCalls++
  const last = body.messages[body.messages.length - 1]
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    const results = last.content.map((b) => b.content).join(' | ')
    return r.fulfill({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text: `Tightened the distal contact. ${results.includes('PASS') || results.includes('Checks') ? 'Checks read.' : ''}` }] } })
  }
  return r.fulfill({ json: { stop_reason: 'tool_use', content: [
    { type: 'tool_use', id: 't1', name: 'adjust_param', input: { param: 'contactDistalMm', mode: 'change', value: -0.02 } },
    { type: 'tool_use', id: 't2', name: 'get_checks', input: {} }
  ] } })
})

const t0 = Date.now()
await page.goto('http://localhost:8799/')
await page.screenshot({ path: `${out}/phone-0-start.png` })
await page.getByRole('button', { name: 'Try the demo' }).click()
await page.waitForSelector('.st-chip.good, .st-chip.meh, .st-chip.bad', { timeout: 120000 })
await page.waitForFunction(() => !document.querySelector('.st-busy'), null, { timeout: 120000 })
console.log(`demo designed in ${((Date.now() - t0) / 1000).toFixed(1)} s (phone emulation, software GL)`)
await page.screenshot({ path: `${out}/phone-1-designed.png` })
const qc = await page.locator('.st-head .st-chip').nth(1).innerText()
console.log('QC chip:', qc)

await page.getByRole('button', { name: /Check/ }).click()
await page.screenshot({ path: `${out}/phone-2-checks.png` })
const fails = await page.locator('.st-checks li.fail').count()
const passes = await page.locator('.st-checks li.pass').count()
console.log(`checks: ${passes} pass, ${fails} fail`)
if (fails) fail('checks failing on the demo case')

// Deterministic grammar path.
await page.getByLabel('Command').fill('tighter mesial contact')
await page.getByLabel('Command').press('Enter')
await page.waitForFunction(() => document.querySelector('.st-status')?.textContent?.includes('contactMesialMm'), null, { timeout: 60000 })
console.log('grammar:', await page.locator('.st-status').innerText())

// AI path (stubbed server, real client tool loop).
await page.getByLabel('Command').fill('the distal feels a little light, can you fix it')
await page.getByLabel('Command').press('Enter')
await page.waitForFunction(() => document.querySelector('.st-status')?.textContent?.startsWith('AI:'), null, { timeout: 60000 })
console.log('ai:', await page.locator('.st-status').innerText(), `(${assistCalls} assist calls)`)
if (assistCalls !== 2) fail('expected two assist round-trips')

await page.getByRole('button', { name: /Design/ }).click()
await page.waitForFunction(() => !document.querySelector('.st-busy'), null, { timeout: 120000 })
const distal = await page.locator('.st-slider').nth(1).innerText()
console.log('distal slider:', distal.replace(/\s+/g, ' '))
if (!distal.includes('-0.05')) fail('AI tool call did not change the distal contact')
await page.screenshot({ path: `${out}/phone-3-design-panel.png` })

// Tap on the crown → sculpt toolbar.
const box = await page.locator('.st-stage canvas').boundingBox()
await page.getByTitle('buccal').click()
await page.waitForTimeout(600)
await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5)
await page.waitForTimeout(300)
console.log('sculpt toolbar:', await page.locator('.st-sculpt').count() ? 'shown' : 'not shown (tap missed the crown)')

await page.getByRole('button', { name: /Export/ }).click()
const dl = page.waitForEvent('download')
await page.getByRole('button', { name: 'Download STL' }).click()
const file = await dl
const path = `${out}/${file.suggestedFilename()}`
await file.saveAs(path)
console.log('exported', file.suggestedFilename())
await page.screenshot({ path: `${out}/phone-4-export.png` })
await browser.close()
server.kill()
console.log('E2E OK')
