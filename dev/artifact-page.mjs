// Turns the artifact build (dist-artifact/index.html) into the page file the
// claude.ai Artifact publisher expects: body content only (it adds the
// doctype/head skeleton), our title, fonts, stylesheet, root and module
// script. Prints the `files` map for the publish call.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
const html = readFileSync('dist-artifact/index.html', 'utf8')
const script = html.match(/<script type="module"[^>]*src="([^"]+)"/)[1]
const css = html.match(/<link rel="stylesheet"[^>]*href="(\.\/assets\/[^"]+)"/)[1]
const page = `<title>SmileHub Crown Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,560&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${css.replace('./', '')}">
<style>html,body{height:100%;background:#0d1f1b}</style>
<div id="root"></div>
<script type="module" src="${script.replace('./', '')}"></script>
`
writeFileSync('dist-artifact/crown-studio.html', page)
const files = Object.fromEntries(readdirSync('dist-artifact/assets').map((f) => [`assets/${f}`, `dist-artifact/assets/${f}`]))
console.log(JSON.stringify(files, null, 1))
