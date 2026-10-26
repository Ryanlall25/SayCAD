/**
 * End-to-end check of the embed connector: a host page (dev/embed-host.html,
 * standing in for the suite, on its own origin) iframes the studio, sends a
 * saycad.crown/1 job, gets the AI outcome, and receives the technician's QC.
 *
 *   npm run build && node dev/e2e-embed.mjs [outDir]
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const { chromium, devices } = createRequire(import.meta.url)('playwright')

const out = process.argv[2] ?? 'e2e-out'
mkdirSync(out, { recursive: true })
const caseDir = join(out, 'syn', 'case-001')
if (!existsSync(join(caseDir, 'patient-lowerjaw.stl'))) execFileSync('npx', ['vite-node', 'scripts/synthetic-cases.ts', '--', join(out, 'syn'), '1'], { stdio: 'inherit' })

const server = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: '8794' }, stdio: 'pipe' })
process.on('exit', () => server.kill())
await new Promise((r) => server.stdout.once('data', r))
const browser = await chromium.launch()
const fail = async (m) => { console.error('E2E FAIL:', m); await browser.close(); process.exit(1) }
const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()
page.on('console', (m) => process.env.DEBUG && console.log('console:', m.type(), m.text()))
page.on('pageerror', (e) => process.env.DEBUG && console.log('pageerror:', e.message))
// The suite lives on its own origin (another port).
const host = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  const file = p === '/' ? 'dev/embed-host.html' : p === '/lower.stl' ? join(caseDir, 'patient-lowerjaw.stl') : p === '/upper.stl' ? join(caseDir, 'patient-upperjaw.stl') : null
  if (!file) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': p === '/' ? 'text/html' : 'model/stl' })
  res.end(readFileSync(file))
}).listen(8792)
process.on('exit', () => host.close())
const t0 = Date.now()
await page.goto('http://localhost:8792/?studio=http://localhost:8794&prep=/lower.stl&antagonist=/upper.stl&tooth=19')
page.on('requestfailed', (r) => console.log('request failed:', r.url(), r.failure()?.errorText))
const logHas = (re) =>
  page.waitForFunction((s) => (window.__log ?? []).some((l) => new RegExp(s).test(l)), re.source, { timeout: 90000 }).catch(async (e) => {
    console.log('host log:', JSON.stringify(await page.evaluate(() => window.__log)))
    await page.screenshot({ path: join(out, 'embed-fail.png') })
    throw e
  })
await logHas(/^outcome: designed/)
const outcomeLine = (await page.evaluate(() => window.__log)).find((l) => l.startsWith('outcome:'))
console.log(`host got the AI outcome in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${outcomeLine}`)
// ArrayBuffers don't cross page.evaluate: measure them in the page.
const o = await page.evaluate(() => {
  const x = window.__messages.find((m) => m.type === 'crown:outcome').outcome
  return { ...x, files: { ...x.files, crownStl: { byteLength: x.files.crownStl.byteLength } } }
})
if (o.contract !== 'saycad.crown/1' || o.jobId !== 'suite-job-1' || o.caseRef !== 'SH-2042') await fail('outcome does not echo the job')
if (!(o.files.crownStl.byteLength > 10000)) await fail('no crown STL in the outcome')
console.log(`outcome: #${o.tooth}, prep by ${o.prepFoundBy}, STL ${o.files.crownStl.byteLength} bytes, ${o.checks.length} checks`)
const studio = page.frameLocator('#studio')
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'embed-1-outcome.png') })
await studio.getByRole('button', { name: 'Approve & Send' }).click()
await logHas(/^QC: /)
const qc = await page.evaluate(() => {
  const m = window.__messages.find((x) => x.type === 'crown:qc')
  return { ...m, outcome: m.outcome && { files: { crownStl: { byteLength: m.outcome.files.crownStl.byteLength } } } }
})
console.log(`QC: ${qc.decision.decision}, crown ${qc.outcome?.files.crownStl.byteLength} bytes, at ${qc.decision.at}`)
if (qc.decision.decision !== 'approved' || !qc.outcome) await fail('approval not delivered')
await browser.close()
console.log('EMBED E2E OK')
process.exit(0)
