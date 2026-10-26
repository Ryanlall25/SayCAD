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
await page.getByRole('button', { name: 'New Crown', exact: true }).click()
await shot('1-tooth-empty')
await swipe()
if ((await count()) !== '1/1') await fail(`moved without a tooth, at ${await count()}`)
console.log('blocked swipe:', await needText())
await page.getByRole('button', { name: 'Tooth 19' }).click()
await page.getByPlaceholder('Patient / case (optional)').fill('Smith, J')
const title = await page.locator('.nc-card[aria-hidden="false"] h1').innerText()
console.log('tooth card:', title, '·', await count())
if (!title.includes('#19') || (await count()) !== '1/3') await fail('tooth not picked / wrong card count')
await shot('2-tooth')
await swipe()
const ask = await page.locator('.nc-card[aria-hidden="false"] .nc-ask').innerText()
console.log('asks:', ask)
if (!ask.includes('LOWER jaw')) await fail('first scan card should ask for the lower jaw')
await swipe()
const need = await needText()
console.log('blocked on scan:', need)
if (!need.includes('LOWER JAW SCAN')) await fail('no "needed now" prompt')
await shot('3-needed')
await choose('Choose Lower jaw scan', [lower])
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '3/3', null, { timeout: 30000 })
console.log('auto-advanced to:', await page.locator('.nc-card[aria-hidden="false"] h1').innerText())
// Wrong file for the upper card: the deck says so and stays put.
await choose('Choose Upper jaw scan', [lower])
await page.waitForSelector('.nc-card[aria-hidden="false"] .nc-warn', { timeout: 30000 })
const warn = await page.locator('.nc-card[aria-hidden="false"] .nc-warn').first().innerText()
console.log('wrong-jaw warning:', warn)
if (!warn.includes('needs the UPPER jaw')) await fail('wrong jaw not flagged')
await shot('4-wrong-jaw')
await choose('Replace', [upper])
await page.waitForFunction(() => !document.querySelector('.nc-card[aria-hidden="false"] .nc-warn'), null, { timeout: 30000 })
await shot('5-ready')
// Design: no tap — the prep is found from the bite and the crown designed.
const t0 = Date.now()
await page.getByRole('button', { name: 'Design Crown' }).click()
await page.waitForSelector('.rv', { timeout: 180000 })
await page.waitForFunction(() => !document.querySelector('.st-hud'), null, { timeout: 120000 })
const chat = await page.locator('.st-status').innerText()
const verdict = await page.locator('.rv-head').innerText()
console.log(`designed without a tap in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, verdict, '|', chat)
if (await page.locator('.st-rail').count()) await fail('stage rail should be hidden in simple mode')
const deck = await page.locator('.rv').innerText()
console.log('review deck:', deck.replace(/\s+/g, ' ').slice(0, 160))
const approve = page.getByRole('button', { name: 'Approve & Export' })
if (!(await approve.count())) await fail('no Approve & Export on the result')
const callouts = await page.locator('.st-callout').allInnerTexts()
console.log('on the model:', callouts.join(' | '))
if (callouts.length !== 3) await fail('measurements are not pinned to the model')
await page.waitForTimeout(800)
await shot('6-result')
await page.getByRole('button', { name: 'Adjust Design' }).click()
if (!(await page.locator('.st-rail').count())) await fail('Adjust Design did not open the stage rail')
console.log('adjust: stage rail shown')
await page.evaluate(() => localStorage.setItem('saycad.pro', '0'))

// ── Path 2: one zip before the tooth is known ───────────────────────────
await page.reload()
await page.getByRole('button', { name: 'New Crown', exact: true }).click()
await choose('Have the whole scanner export? Import the .zip', [zipPath])
await page.waitForSelector('.nc-note', { timeout: 30000 })
console.log('zip held:', await page.locator('.nc-note').innerText())
await page.getByRole('button', { name: 'Tooth 19' }).click()
await page.waitForFunction(() => document.querySelector('.nc-count')?.textContent === '3/3', null, { timeout: 30000 })
const placed = await page.locator('.nc-file-main b').allInnerTexts()
console.log('zip placed:', placed.join(' | '))
if (!placed.includes('Smith-mandibular.stl') || !placed.includes('Smith-maxillary.stl')) await fail('zip scans not placed by jaw')
if (!(await page.getByRole('button', { name: 'Design Crown' }).count())) await fail('no Design Crown after the zip')
await shot('7-zip-ready')

await browser.close()
server.kill()
console.log('NEW CASE E2E OK')
