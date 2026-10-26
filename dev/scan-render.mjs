// node dev/scan-render.mjs <out.png> "<query>"  — screenshots dev/scan-view.html
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const { chromium } = createRequire(import.meta.url)('playwright')
const [out, qs] = process.argv.slice(2)
const server = await createServer({ server: { port: 5198 }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 800, height: 800 } })
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))
await page.goto(`http://localhost:5198/dev/scan-view.html?${qs}`)
await page.waitForFunction(() => document.title === 'ready', null, { timeout: 300000 })
await page.screenshot({ path: out })
console.log(JSON.stringify(await page.evaluate(() => window.__info)))
await browser.close()
await server.close()
