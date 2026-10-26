/**
 * SayCAD server: serves the built app (dist/) and the Claude endpoints.
 * The browser never sees the API key — every Claude call goes through here,
 * with a fixed system prompt and a fixed tool set.
 *
 *   ANTHROPIC_API_KEY=… [SAYCAD_ACCESS_CODE=…] [PORT=8787] node server/index.mjs
 *
 * Set SAYCAD_ACCESS_CODE whenever the server is reachable by anyone else:
 * without it, anyone who can load the page can spend the lab's API credit.
 */
import http from 'node:http'
import { Worker } from 'node:worker_threads'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import tools from '../src/ai/crownTools.json' with { type: 'json' }
import prompts from '../src/ai/prompts.json' with { type: 'json' }

// System prompts are shared with the in-browser (claude.ai artifact) backend.
// Static text only — no timestamps or per-request data — so they cache.
const { assist: ASSIST_SYSTEM, review: REVIEW_SYSTEM, rx: RX_SYSTEM } = prompts

const here = fileURLToPath(new URL('.', import.meta.url))
const DIST = resolve(here, '..', 'dist')
const PORT = Number(process.env.PORT ?? 8787)
const MODEL = process.env.SAYCAD_MODEL ?? 'claude-opus-5-5'
const ACCESS_CODE = process.env.SAYCAD_ACCESS_CODE ?? ''
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
const client = hasKey ? new Anthropic() : null

// Server-side refusal fallback: a declined request is re-run on Anthropic's
// recommended fallback model instead of returning the refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req, limit = 15 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 })
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
}

function apiError(res, err) {
  if (err instanceof Anthropic.AuthenticationError) return send(res, 500, { error: 'The server’s Anthropic API key is invalid.' })
  if (err instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'AI is rate-limited — try again in a minute.' })
  if (err instanceof Anthropic.BadRequestError) return send(res, 400, { error: `AI request rejected: ${err.message}` })
  if (err instanceof Anthropic.APIError) return send(res, 502, { error: `AI service error ${err.status ?? ''}`.trim() })
  if (err?.status) return send(res, err.status, { error: err.message })
  console.error(err)
  return send(res, 500, { error: 'Server error' })
}

const validImage = (img) =>
  img && typeof img.data === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(img.mediaType)

async function assist(body) {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 80) throw Object.assign(new Error('bad messages'), { status: 400 })
  const response = await client.beta.messages.create({
    ...FALLBACK,
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: ASSIST_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools,
    messages
  })
  return { content: response.content, stop_reason: response.stop_reason, stop_details: response.stop_details ?? null, model: response.model }
}

async function review(body) {
  const images = (body.images ?? []).filter(validImage).slice(0, 4)
  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    { type: 'text', text: `Tooth #${Number(body.tooth) || '?'}; material ${String(body.material ?? 'unknown')}.\nQuality-check report:\n${JSON.stringify(body.report ?? {}, null, 1).slice(0, 20000)}\nDesign measures:\n${JSON.stringify(body.measures ?? {}).slice(0, 4000)}` }
  ]
  const response = await client.beta.messages.create({
    ...FALLBACK,
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: 'medium' },
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content }]
  })
  if (response.stop_reason === 'refusal') return { text: 'The AI reviewer declined this request.' }
  return { text: textOf(response) }
}

const RX_SCHEMA = {
  type: 'object',
  properties: {
    teeth: { type: 'array', items: { type: 'integer' } },
    restoration: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    material: { anyOf: [{ type: 'string', enum: ['zirconia-hs', 'zirconia-ht', 'lithium-disilicate', 'pmma-temp', 'cast-wax'] }, { type: 'null' }] },
    shade: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['teeth', 'restoration', 'material', 'shade', 'notes'],
  additionalProperties: false
}

async function rx(body) {
  if (!validImage(body.image)) throw Object.assign(new Error('need a png/jpeg/webp image'), { status: 400 })
  const response = await client.beta.messages.create({
    ...FALLBACK,
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RX_SCHEMA } },
    system: RX_SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: body.image.mediaType, data: body.image.data } },
      { type: 'text', text: 'Extract the crown & bridge fields from this prescription.' }
    ] }]
  })
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined to read this image.'), { status: 422 })
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('The AI response was cut off.'), { status: 502 })
  return JSON.parse(textOf(response))
}

const ROUTES = { '/api/assist': assist, '/api/review': review, '/api/rx': rx }

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x')
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, path)
  if (!file.startsWith(DIST)) return send(res, 403, { error: 'forbidden' })
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html') // SPA fallback
  }
  try {
    const data = await readFile(file)
    const immutable = file.includes(`${join(DIST, 'assets')}`)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
    res.end(data)
  } catch {
    send(res, 404, { error: 'not found — run `npm run build` first' })
  }
}

/* ── Crown module over HTTP (saycad.crown/1) ──────────────────────────────
 *   GET  /api/crown/v1                       contract, version, ready
 *   POST /api/crown/v1/design?tooth=19[&system=fdi][&material=…][&caseRef=…][&jobId=…][&alignZ=1]
 *        body: the case as a .zip (scans + optional job.json / .dentalProject)
 *        → outcome JSON with links to its files; Accept: application/zip → the files as a zip
 *   GET  /api/crown/v1/jobs/<jobId>/<file>   crown STL, design-record.json, outcome.json, outcome.zip
 * Jobs run in a worker thread; results are kept in memory for an hour.
 */
const MODULE = resolve(here, '..', 'dist-module', 'index.js')
const ANATOMY = {}
const MODELS = resolve(here, '..', 'public', 'models')
if (existsSync(MODELS)) for (const f of readdirSync(MODELS)) {
  const m = /^ssm-(\w+)\.json$/.exec(f)
  if (m) ANATOMY[m[1]] = readFileSync(join(MODELS, f), 'utf8')
}
const jobs = new Map() // jobId → { at, files: [{name, data}] }

function readBody(req, limit = 400 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    const parts = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > limit) {
        fail(Object.assign(new Error('Case is larger than 400 MB.'), { status: 413 }))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => ok(Buffer.concat(parts)))
    req.on('error', fail)
  })
}

function runCrownJob(workerData) {
  return new Promise((ok, fail) => {
    const w = new Worker(new URL('./crown-worker.mjs', import.meta.url), { workerData })
    w.once('message', ok)
    w.once('error', fail)
  })
}

async function crownApi(req, res, url) {
  const ready = existsSync(MODULE)
  if (url.pathname === '/api/crown/v1') return send(res, 200, { contract: 'saycad.crown/1', ready, anatomy: Object.keys(ANATOMY) })
  if (!ready) return send(res, 503, { error: 'Crown module not built — run `npm run build:module`.' })
  if (ACCESS_CODE && req.headers['x-saycad-access'] !== ACCESS_CODE) return send(res, 401, { error: 'Access code required.' })
  const file = /^\/api\/crown\/v1\/jobs\/([\w.-]+)\/([\w.-]+)$/.exec(url.pathname)
  if (file && req.method === 'GET') {
    const j = jobs.get(file[1])
    const f = j?.files.find((x) => x.name === file[2])
    if (!f) return send(res, 404, { error: 'No such job file (results are kept for an hour).' })
    res.writeHead(200, { 'content-type': f.name.endsWith('.json') ? 'application/json' : f.name.endsWith('.zip') ? 'application/zip' : 'model/stl', 'content-disposition': `attachment; filename="${f.name}"` })
    return res.end(Buffer.from(f.data))
  }
  if (url.pathname !== '/api/crown/v1/design' || req.method !== 'POST') return send(res, 404, { error: 'Unknown crown endpoint.' })
  try {
    const body = await readBody(req)
    if (!body.length) return send(res, 400, { error: 'Send the case as a .zip in the request body.' })
    const q = url.searchParams
    const order = {}
    if (q.get('tooth')) order.tooth = Number(q.get('tooth'))
    if (q.get('system')) order.system = q.get('system')
    if (q.get('material')) order.material = q.get('material')
    if (q.get('shade')) order.shade = q.get('shade')
    if (q.get('caseRef')) order.caseRef = q.get('caseRef')
    const jobId = (q.get('jobId') ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).replace(/[^\w.-]/g, '_')
    const data = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    const r = await runCrownJob({ files: [{ name: 'case.zip', data }], order, jobId, anatomy: ANATOMY, alignZ: q.get('alignZ') === '1' })
    if (!r.outcome) return send(res, 422, { error: r.problems.join(' '), notes: r.notes })
    const files = [...r.files]
    jobs.set(jobId, { at: Date.now(), files })
    for (const [k, v] of jobs) if (Date.now() - v.at > 3600_000) jobs.delete(k)
    if ((req.headers.accept ?? '').includes('application/zip')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${jobId}.zip"` })
      return res.end(Buffer.from(zipFiles(files)))
    }
    const link = (n) => `/api/crown/v1/jobs/${jobId}/${n}`
    return send(res, 200, { ...r.outcome, notes: r.notes, links: Object.fromEntries(files.map((f) => [f.name, link(f.name)])) })
  } catch (err) {
    return send(res, err.status ?? 500, { error: err.message })
  }
}

// Minimal STORE zip for the outcome files (same layout as src/core/zip.ts).
function zipFiles(files) {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (d) => {
    let c = 0xffffffff
    for (let i = 0; i < d.length; i++) c = crcT[(c ^ d[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const parts = []
  const central = []
  let off = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const data = Buffer.from(f.data)
    const c = crc(data)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(c, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26)
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt32LE(c, 16); h.writeUInt32LE(data.length, 20); h.writeUInt32LE(data.length, 24); h.writeUInt16LE(name.length, 28); h.writeUInt32LE(off, 42)
    parts.push(l, name, data)
    central.push(h, name)
    off += 30 + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, e])
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/health') return send(res, 200, { ai: hasKey, needsCode: Boolean(ACCESS_CODE), model: MODEL })
    if (url.pathname.startsWith('/api/crown/')) return crownApi(req, res, url)
    const route = ROUTES[url.pathname]
    if (!route) return serveStatic(req, res)
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
    if (!client) return send(res, 503, { error: 'AI is not configured on this server (set ANTHROPIC_API_KEY).' })
    if (ACCESS_CODE && req.headers['x-saycad-access'] !== ACCESS_CODE) return send(res, 401, { error: 'Access code required.' })
    try {
      send(res, 200, await route(await readJson(req)))
    } catch (err) {
      apiError(res, err)
    }
  })
  .listen(PORT, () => console.log(`SayCAD on http://localhost:${PORT} — AI ${hasKey ? `on (${MODEL})` : 'off (no ANTHROPIC_API_KEY)'}${ACCESS_CODE ? ', access code required' : ''}`))
