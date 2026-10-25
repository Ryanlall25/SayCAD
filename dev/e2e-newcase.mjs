/**
 * End-to-end check of the New Case deck on a phone-sized viewport: the
 * order cards, swipe gating ("needed now"), one scan card per scan with
 * wrong-jaw detection, zip import before the tooth is known, and the
 * hand-off to the designer. Uses a synthetic case (lower molar #19).
 *
 *   npm run build && node dev/e2e-newcase.mjs [outDir]
 */
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateRawSync, crc32 } from 'node:zlib'
import { join } from 'node:path'
const { chromium, devices } = createRequire(import.meta.url)('playwright')

const out = process.argv[2] ?? 'e2e-out'
mkdirSync(out, { recursive: true })
const caseDir = join(out, 'syn', 'case-001')
if (!existsSync(join(caseDir, 'patient-lowerjaw.stl'))) execFileSync('npx', ['vite-node', 'scripts/synthetic-cases.ts', '--', join(out, 'syn'), '1'], { stdio: 'inherit' })
const lower = join(caseDir, 'patient-lowerjaw.stl')
const upper = join(caseDir, 'patient-upperjaw.stl')

/** A DEFLATE zip, the way scanner exports arrive. */
function zipFiles(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, data] of entries) {
    const n = Buffer.from(name)
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
    parts.push(local, n, comp)
    central.push(c, n)
    offset += 30 + n.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}
const zipPath = join(out, 'Smith_iTero_export.zip')
writeFileSync(zipPath, zipFiles([
  ['Smith/Smith-mandibular.stl', readFileSync(lower)],
  ['Smith/Smith-maxillary.stl', readFileSync(upper)],
  ['Smith/readme.txt', Buffer.from('scanner export')]
]))

const server = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: '8797' }, stdio: 'pipe' })
process.on('exit', () => server.kill()) // also when a step throws
await new Promise((r) => server.stdout.once('data', r))
const browser = await chromium.launch()
const fail = async (m) => { console.error('E2E FAIL:', m); await browser.close(); server.kill(); process.exit(1) }
const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()
const shot = (name) => page.screenshot({ path: join(out, `nc-${name}.png`) })
const needText = async () => ((await page.locator('.nc-need').count()) ? page.locator('.nc-need').innerText() : '')
const count = () => page.locator('.nc-count').innerText()
async function swipe(dir = -1) {
  const box = await page.locator('.nc-deck').boundingBox()
  const y = box.y + box.height * 0.18
  const x0 = box.x + box.width * (dir < 0 ? 0.85 : 0.15)
  await page.mouse.move(x0, y)
  await page.mouse.down()
  for (let k = 1; k <= 8; k++) await page.mouse.move(x0 + dir * k * box.width * 0.08, y)
  await page.mouse.up()
  await page.waitForTimeout(450)
}
async function choose(buttonName, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName }).click()])
  await chooser.setFiles(files)
}

// ── Path 1: card by card ────────────────────────────────────────────────
await page.goto('http://localhost:8797/')
await page.getByRole('button', { name: 'New Case', exact: true }).click()
await page.getByPlaceholder('Name or case number').fill('Smith, J')
await page.getByPlaceholder('Practice or dentist').fill('Vita Dental')
await shot('1-order')
await swipe()
if ((await count()) !== '2/5') await fail(`expected the tooth card, at ${await count()}`)
await swipe()
if ((await count()) !== '2/5') await fail('swiped past the tooth card without a tooth')
console.log('blocked swipe:', await needText())
await page.getByRole('button', { name: 'Tooth 19' }).click()
const title = await page.locator('.nc-card[aria-hidden="false"] h1').innerText()
console.log('tooth card:', title)
if (!title.includes('#19')) await fail('tooth not picked')
await shot('2-tooth')
await swipe()
await shot('3-restoration')
await swipe()
const plan = await page.locator('.nc-card[aria-hidden="false"] .nc-plan').allInnerTexts()
console.log('scan plan:', plan.map((p) => p.replace(/\s+/g, ' ')).join(' | '))
if (!plan[0]?.includes('Lower jaw scan') || !plan[1]?.includes('Upper jaw scan')) await fail('wrong scan plan for #19')
await shot('4-scans')
await swipe()
const ask = await page.locator('.nc-card[aria-hidden="false"] .nc-ask').innerText()
console.log('asks:', ask)
if (!ask.includes('LOWER jaw')) await fail('first scan card should ask for the lower jaw')
await swipe()
const need = await needText()
console.log('blocked on scan:', need)
if (!need.includes('LOWER JAW SCAN')) await fail('no "needed now" prompt')
await shot('5-needed')
await choose('Choose Lower jaw scan', [lower])
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '6/7', null, { timeout: 30000 })
console.log('auto-advanced to:', await page.locator('.nc-card[aria-hidden="false"] h1').innerText())
// Wrong file for the upper slot: the deck should say so and stay put.
await choose('Choose Upper jaw scan', [lower])
await page.waitForSelector('.nc-card[aria-hidden="false"] .nc-warn', { timeout: 30000 })
const warn = await page.locator('.nc-card[aria-hidden="false"] .nc-warn').first().innerText()
console.log('wrong-jaw warning:', warn)
if (!warn.includes('needs the UPPER jaw')) await fail('wrong jaw not flagged')
await shot('6-wrong-jaw')
await choose('Replace', [upper])
await page.waitForFunction(() => !document.querySelector('.nc-card[aria-hidden="false"] .nc-warn'), null, { timeout: 30000 })
await swipe()
if ((await count()) !== '7/7') await fail('did not reach the review')
const review = await page.locator('.nc-card[aria-hidden="false"] .nc-row').allInnerTexts()
console.log('review:', review.map((r) => r.replace(/\s+/g, ' ').trim()).join(' | '))
await shot('7-review')
await page.getByRole('button', { name: 'Design Crown' }).click()
await page.waitForFunction(() => document.querySelector('.st-coach')?.textContent?.includes('Tap the prepared tooth'), null, { timeout: 60000 })
const nav = await page.locator('.st-nav').innerText()
console.log('designer:', nav.replace(/\s+/g, ' '))
if (!nav.includes('#19')) await fail('designer did not open on #19')
await shot('8-designer')

// ── Path 2: one zip before the tooth is known ───────────────────────────
await page.reload()
await page.getByRole('button', { name: 'New Case', exact: true }).click()
await choose('Import All Files', [zipPath])
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '2/5', null, { timeout: 30000 })
console.log('zip held:', await page.locator('.nc-note').innerText())
await page.getByRole('button', { name: 'Tooth 19' }).click()
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '7/7', null, { timeout: 30000 })
const zipReview = await page.locator('.nc-card[aria-hidden="false"] .nc-row').allInnerTexts()
console.log('zip review:', zipReview.map((r) => r.replace(/\s+/g, ' ').trim()).join(' | '))
if (!zipReview.join().includes('Smith-mandibular.stl') || !zipReview.join().includes('Smith-maxillary.stl')) await fail('zip scans not placed by jaw')
await shot('9-zip-review')

await browser.close()
server.kill()
console.log('NEW CASE E2E OK')
