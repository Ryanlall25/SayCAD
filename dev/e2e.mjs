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
await page.getByRole('button', { name: 'Try the Demo Case' }).click()
await page.waitForSelector('.st-verdict', { timeout: 120000 })
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
console.log(`demo designed in ${((Date.now() - t0) / 1000).toFixed(1)} s (phone emulation, software GL)`)
await page.waitForTimeout(800) // camera settles above the sheet
await page.screenshot({ path: `${out}/phone-1-designed.png` })
console.log('QC pill:', await page.locator('.st-nav .st-pill').first().innerText())
console.log('design run:', (await page.locator('.st-runrow').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '))

await page.locator('.st-rail-item', { hasText: 'Check' }).click()
await page.screenshot({ path: `${out}/phone-2-checks.png` })
const fails = await page.locator('.st-check.fail').count()
const passes = await page.locator('.st-check.pass').count()
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
await page.waitForFunction(() => document.querySelector('.st-status')?.textContent?.startsWith('AI ·'), null, { timeout: 60000 })
console.log('ai:', await page.locator('.st-status').innerText(), `(${assistCalls} assist calls)`)
if (assistCalls !== 2) fail('expected two assist round-trips')

await page.locator('.st-rail-item', { hasText: 'Adapt' }).click()
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
const distal = await page.locator('.st-slider').nth(1).innerText()
console.log('distal slider:', distal.replace(/\s+/g, ' '))
if (!distal.includes('-0.05')) fail('AI tool call did not change the distal contact')
await page.screenshot({ path: `${out}/phone-3-design-panel.png` })

// Tap on the crown → sculpt toolbar.
const box = await page.locator('.st-stage canvas').boundingBox()
await page.getByRole('button', { name: 'buccal view' }).click()
await page.waitForTimeout(600)
// Centre of the area the sheet and nav leave visible — where the crown is drawn.
const navBottom = (await page.locator('.st-rail').boundingBox()).y + 40
const sheetTop = (await page.locator('.st-sheet').boundingBox()).y
await page.mouse.click(box.x + box.width / 2, (navBottom + sheetTop) / 2)
await page.waitForTimeout(300)
console.log('sculpt toolbar:', (await page.getByRole('button', { name: '+ 0.1' }).count()) ? 'shown' : 'not shown (tap missed the crown)')

await page.locator('.st-rail-item', { hasText: 'Export' }).click()
const dl = page.waitForEvent('download', { predicate: (d) => d.suggestedFilename().endsWith('.stl') })
await page.getByRole('button', { name: 'Download STL' }).click()
const file = await dl
const path = `${out}/${file.suggestedFilename()}`
await file.saveAs(path)
console.log('exported', file.suggestedFilename())
await page.screenshot({ path: `${out}/phone-4-export.png` })

// Reopen the saved case after a reload (on-device storage).
await page.reload()
await page.waitForSelector('.st-welcome')
await page.waitForSelector('.st-row-btn', { timeout: 10000 })
console.log('saved cases:', await page.locator('.st-row-btn').count(), '—', (await page.locator('.st-row-btn').first().innerText()).replace(/\s+/g, ' '))
await page.locator('.st-row-btn').first().click()
await page.waitForSelector('.st-nav .st-pill.good, .st-nav .st-pill.meh, .st-nav .st-pill.bad', { timeout: 120000 })
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
await page.locator('.st-rail-item', { hasText: 'Adapt' }).click()
const reopenedDistal = await page.locator('.st-slider').nth(1).innerText()
console.log('reopened distal slider:', reopenedDistal.replace(/\s+/g, ' '))
if (!reopenedDistal.includes('-0.05')) fail('reopened case lost its parameters')

// Tooth library import (optional: LIB_DIR=<folder of tooth STLs>).
if (process.env.LIB_DIR) {
  const { readdirSync } = await import('node:fs')
  const libFiles = readdirSync(process.env.LIB_DIR).filter((f) => /\.stl$/i.test(f)).map((f) => `${process.env.LIB_DIR}/${f}`)
  await page.locator('.st-rail-item', { hasText: 'Scans' }).click()
  await page.locator('input[type=file]').nth(1).setInputFiles(libFiles)
  await page.waitForSelector('.st-note >> text=teeth imported', { timeout: 120000 })
  console.log('library:', (await page.locator('.st-note', { hasText: 'teeth imported' }).innerText()).slice(0, 120))
  await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
  await page.locator('.st-rail-item', { hasText: 'Anatomy' }).click()
  const anat = await page.locator('.st-row-main b').first().innerText()
  console.log('anatomy:', anat)
  if (!anat.includes('library')) fail('imported library not used')
  console.log('QC with library anatomy:', await page.locator('.st-nav .st-pill').first().innerText())
  await page.screenshot({ path: `${out}/phone-5-library.png` })
}

// ── claude.ai-hosted mode: the artifact build with a stand-in runtime ──────
// The fake `sample` behaves like the platform: it calls the page's own tool
// functions and returns text; `downloads.save` captures what would be saved.
const { createServer } = await import('node:http')
const { readFile } = await import('node:fs/promises')
const { join, extname } = await import('node:path')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const art = createServer(async (req, res) => {
  const path = join('dist-artifact', decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'))
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}).listen(8798)
const page2 = await ctx.newPage()
page2.on('pageerror', (e) => console.log('pageerror(artifact):', e.message))
await page2.addInitScript(() => {
  const calls = []
  window.__sampleCalls = calls
  const sample = async (input, opts = {}) => {
    const turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input
    const last = turns[turns.length - 1].content
    calls.push({ tools: (opts.tools ?? []).map((t) => t.name), images: opts.images?.length ?? 0, last: last.slice(-120) })
    if (opts.tools && /distal/i.test(last)) {
      const tool = opts.tools.find((t) => t.name === 'adjust_param')
      const out = await tool.execute({ param: 'contactDistalMm', mode: 'change', value: -0.02 }, { signal: new AbortController().signal })
      return { text: `Tightened the distal contact.\n\nDone — ${String(out).slice(0, 40)}`, truncated: false, modelTierApplied: 'quick' }
    }
    return { text: 'Verdict: ready to mill. No issues found.', truncated: false, modelTierApplied: 'default' }
  }
  sample.json = async () => ({ teeth: [19], material: 'lithium-disilicate', restoration: 'crown', shade: 'A2', notes: null })
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 2e7, mediaTypes: ['image/png', 'image/jpeg'] }, tools: { maxCount: 16 } })
  const downloads = { save: async ({ filename, data }) => { const buf = new Uint8Array(await data.arrayBuffer()); window.__saved = { filename, bytes: Array.from(buf) }; return { status: 'saved' } } }
  window.claude = { use: async (name) => (name === 'sample' ? sample : name === 'downloads' ? downloads : null) }
})
await page2.goto('http://localhost:8798/')
await page2.getByRole('button', { name: 'Try the Demo Case' }).click()
await page2.waitForSelector('.st-review', { timeout: 120000 })
await page2.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
console.log('artifact: AI pill =', await page2.locator('.st-pill.ai').innerText().catch(() => 'missing'))
console.log('artifact run:', (await page2.locator('.st-runrow').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '))
await page2.screenshot({ path: `${out}/artifact-run.png` })
await page2.getByLabel('Command').fill('make the distal a touch tighter please')
await page2.getByLabel('Command').press('Enter')
await page2.waitForFunction(() => document.querySelector('.st-status')?.textContent?.startsWith('AI ·'), null, { timeout: 60000 })
console.log('artifact ai:', await page2.locator('.st-status').innerText())
await page2.locator('.st-rail-item', { hasText: 'Check' }).click()
await page2.getByRole('button', { name: 'AI Review' }).click()
await page2.waitForSelector('.st-review', { timeout: 60000 })
console.log('artifact review:', await page2.locator('.st-review').innerText())
const calls = await page2.evaluate(() => window.__sampleCalls)
console.log('sample calls:', JSON.stringify(calls.map((c) => ({ tools: c.tools.length, images: c.images }))))
if (!calls.some((c) => c.images === 3)) fail('review should send three renders')
await page2.locator('.st-rail-item', { hasText: 'Export' }).click()
await page2.getByRole('button', { name: 'Download (.zip)' }).click()
await page2.waitForFunction(() => window.__saved, null, { timeout: 30000 })
const saved = await page2.evaluate(() => window.__saved)
const { writeFileSync } = await import('node:fs')
writeFileSync(`${out}/${saved.filename}`, Buffer.from(saved.bytes))
console.log('artifact export:', saved.filename, saved.bytes.length, 'bytes')
art.close()

await browser.close()
server.kill()
console.log('E2E OK')
