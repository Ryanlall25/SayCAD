// Renders dev/preview.html views to PNGs: node dev/render.mjs <outDir> [views...]
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { createServer } from 'vite'
const out = process.argv[2] ?? '.'
const extra = process.env.PREVIEW_QS ?? ''
const views = process.argv.slice(3).length ? process.argv.slice(3) : ['buccal', 'occlusal', 'mesial', 'lingual']
const server = await createServer({ server: { port: 5199 }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))
for (const v of views) {
  const [view, hide] = v.split(':')
  await page.goto(`http://localhost:5199/dev/preview.html?view=${view}${hide ? '&hide=' + hide : ''}${extra}`)
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 120000 })
  await page.screenshot({ path: `${out}/crown-${v.replace(':', '-')}.png` })
}
console.log(await page.evaluate(() => window.__report))
await browser.close()
await server.close()
