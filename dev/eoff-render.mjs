import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { readdirSync } from 'node:fs'
const { chromium } = createRequire(import.meta.url)('playwright')
const out = process.argv[2]
const server = await createServer({ server: { port: 5198 }, logLevel: 'error' }); await server.listen()
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 500, height: 500 } })
for (const f of readdirSync('dev/eoff').filter((x) => x.endsWith('.eoff'))) for (const v of ['top', 'front']) {
  await p.goto(`http://localhost:5198/dev/eoff-view.html?f=${f}&v=${v}`)
  await p.waitForFunction(() => document.title === 'ready', null, { timeout: 60000 })
  await p.screenshot({ path: `${out}/${f.replace('.eoff', '')}-${v}.png` })
}
await b.close(); await server.close()
