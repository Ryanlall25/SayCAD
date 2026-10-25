// Renders public/icon.svg to the PNG sizes the manifest and iOS need.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const { chromium } = createRequire(import.meta.url)('playwright')
const svg = readFileSync('public/icon.svg', 'utf8')
const browser = await chromium.launch()
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
  await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: true })
}
await browser.close()
