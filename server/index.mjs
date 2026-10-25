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

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/health') return send(res, 200, { ai: hasKey, needsCode: Boolean(ACCESS_CODE), model: MODEL })
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
