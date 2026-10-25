import type Anthropic from '@anthropic-ai/sdk'
import type { CrownCommand, CrownLayer, CrownView, NumericParam } from '../speak/crownParser'
import type { MaterialId } from '../crown/materials'

/**
 * Browser side of the Claude layer. The server (server/index.mjs) owns the
 * key, the system prompts and the tool set; this module runs the tool loop:
 * send the conversation, execute the tool calls Claude makes through the
 * same executor as typed/spoken commands, return the results, repeat until
 * Claude answers in text.
 *
 * The conversation is append-only (assistant turns are echoed back exactly
 * as received, thinking blocks included), which is what keeps the model's
 * reasoning valid across turns.
 */

type ContentBlock = Anthropic.Beta.BetaContentBlock
type MessageParam = Anthropic.Beta.BetaMessageParam

export interface AiStatus {
  ai: boolean
  needsCode: boolean
  model?: string
}

const CODE_KEY = 'saycad.accessCode'

export function accessCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setAccessCode(code: string): void {
  try {
    localStorage.setItem(CODE_KEY, code)
  } catch {
    /* private mode: code lives for this page only */
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saycad-access': accessCode() },
    body: JSON.stringify(body)
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(json.error ?? `AI request failed (${res.status})`)
  return json as T
}

export async function aiStatus(): Promise<AiStatus> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return { ai: false, needsCode: false }
    return (await res.json()) as AiStatus
  } catch {
    return { ai: false, needsCode: false }
  }
}

/** Maps one tool call onto the shared command type (inputs validated + clamped). */
export function toolToCommand(name: string, input: Record<string, unknown>): CrownCommand | { kind: 'getChecks' } | null {
  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null
  switch (name) {
    case 'set_tooth': {
      const t = num(input.tooth, 1, 32)
      return t === null ? null : { kind: 'setTooth', tooth: Math.round(t) }
    }
    case 'run_auto_design':
      return { kind: 'autoDesign' }
    case 'adjust_param': {
      const v = num(input.value, -45, 45)
      if (v === null || typeof input.param !== 'string') return null
      return { kind: 'param', param: input.param as NumericParam, mode: input.mode === 'set' ? 'set' : 'change', value: v }
    }
    case 'set_material':
      return typeof input.material === 'string' ? { kind: 'material', material: input.material as MaterialId } : null
    case 'set_occlusal_contacts':
      return { kind: 'occlusalContacts', on: Boolean(input.on) }
    case 'sculpt': {
      const a = num(input.amount_mm, -1, 1)
      const r = num(input.radius_mm, 0.5, 4)
      if (a === null || r === null || typeof input.region !== 'string') return null
      return { kind: 'sculpt', region: input.region, amountMm: a, radiusMm: r }
    }
    case 'flip_buccal':
      return { kind: 'flipBuccal' }
    case 'set_view':
      return { kind: 'view', view: input.view as CrownView }
    case 'set_layer':
      return { kind: 'layer', layer: input.layer as CrownLayer, visible: Boolean(input.visible) }
    case 'get_checks':
      return { kind: 'getChecks' }
    case 'undo':
      return { kind: 'undo' }
    default:
      return null
  }
}

export interface AssistTurn {
  /** Final text Claude replied with. */
  reply: string
  /** One line per tool executed, for the activity log. */
  actions: string[]
}

/**
 * One user request through the tool loop. `execute` runs a command and
 * returns a short result string for Claude (what changed + key checks).
 */
export async function assist(
  history: MessageParam[],
  userText: string,
  stateSummary: string,
  execute: (cmd: CrownCommand | { kind: 'getChecks' }) => Promise<string>
): Promise<AssistTurn> {
  history.push({
    role: 'user',
    content: [
      { type: 'text', text: `Current design state:\n${stateSummary}` },
      { type: 'text', text: userText }
    ]
  })
  const actions: string[] = []
  for (let round = 0; round < 8; round++) {
    const r = await post<{ content: ContentBlock[]; stop_reason: string; stop_details: { explanation?: string } | null }>('/api/assist', { messages: history })
    history.push({ role: 'assistant', content: r.content as unknown as Anthropic.Beta.BetaContentBlockParam[] })
    if (r.stop_reason === 'refusal') return { reply: r.stop_details?.explanation ?? 'The AI declined that request.', actions }
    const calls = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    if (!calls.length || r.stop_reason !== 'tool_use') {
      const text = r.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
      return { reply: text || 'Done.', actions }
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const call of calls) {
      const cmd = toolToCommand(call.name, (call.input ?? {}) as Record<string, unknown>)
      if (!cmd) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Invalid tool input.', is_error: true })
        continue
      }
      try {
        const out = await execute(cmd)
        actions.push(`${call.name} ${JSON.stringify(call.input)}`)
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out })
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: e instanceof Error ? e.message : String(e), is_error: true })
      }
    }
    // All results for this turn go back in a single user message.
    history.push({ role: 'user', content: results })
  }
  return { reply: 'Stopped after several steps — tell me what to do next.', actions }
}

export async function aiReview(payload: {
  tooth: number
  material: string
  report: unknown
  measures: unknown
  images: Array<{ mediaType: 'image/png' | 'image/jpeg'; data: string }>
}): Promise<string> {
  const r = await post<{ text: string }>('/api/review', payload)
  return r.text
}

export interface RxFields {
  teeth: number[]
  restoration: string | null
  material: MaterialId | null
  shade: string | null
  notes: string | null
}

export async function readRx(image: { mediaType: 'image/jpeg' | 'image/png'; data: string }): Promise<RxFields> {
  return post<RxFields>('/api/rx', { image })
}

/** Downscales a photo to ≤ maxSide px JPEG, base64 (no data: prefix). */
export async function photoToBase64(file: File, maxSide = 1600): Promise<{ mediaType: 'image/jpeg'; data: string }> {
  const bmp = await createImageBitmap(file)
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * s)
  canvas.height = Math.round(bmp.height * s)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', 0.85)
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) }
}
