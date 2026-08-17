/**
 * The SayCAD command grammar — a pure function from one spoken or typed
 * sentence to a structured command. Deliberately deterministic (no model in
 * the loop yet): every phrase the app claims to understand is testable here,
 * and an LLM front-end can later compile free speech down to THIS grammar
 * rather than to raw scene mutations.
 */
import type { ToothType } from '../core/toothLibrary'

export type Command =
  | { kind: 'addTooth'; tooth: number }
  | { kind: 'addToothType'; toothType: ToothType }
  | { kind: 'arch'; arch: 'upper' | 'lower' | 'both' }
  | { kind: 'primitive'; shape: 'box' | 'cylinder' | 'sphere'; dims: number[] }
  | { kind: 'move'; axis: 'x' | 'y' | 'z'; mm: number }
  | { kind: 'rotate'; axis: 'x' | 'y' | 'z'; deg: number }
  | { kind: 'scale'; factor: number }
  | { kind: 'color'; color: string }
  | { kind: 'duplicate' }
  | { kind: 'remove' }
  | { kind: 'clear' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'export'; format: 'stl' | 'ply' }
  | { kind: 'import' }
  | { kind: 'grid' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string }

/** Number words voice dictation may hand us instead of digits (1–32). */
const NUMBER_WORDS: Record<string, number> = {}
const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
ONES.forEach((w, i) => { NUMBER_WORDS[w] = i })
;['twenty','thirty'].forEach((tens, t) => {
  const base = (t + 2) * 10
  NUMBER_WORDS[tens] = base
  for (let i = 1; i <= 9; i++) NUMBER_WORDS[`${tens}-${ONES[i]}`] = base + i
})

/** Lowercase, strip punctuation, convert number words to digits. */
export function normalize(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[,!?;:]/g, ' ')
    .replace(/\.(?!\d)/g, ' ') // keep decimal points ("2.5"), strip sentence periods
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w))
  return words.join(' ')
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const TOOTH_TYPES: ToothType[] = ['incisor', 'canine', 'premolar', 'molar']

/** CSS color words we pass straight to three.js, plus brand shades. */
const COLOR_ALIASES: Record<string, string> = {
  gold: '#c9a24b',
  ivory: '#f0ead9',
  teal: '#0b5d52',
  wax: '#7ea0c4',
  gum: '#c78a86'
}
const CSS_COLORS = ['white', 'black', 'red', 'green', 'blue', 'orange', 'purple', 'pink', 'gray', 'grey', 'silver', 'brown', 'yellow']

export function parse(raw: string): Command {
  const text = normalize(raw)
  if (!text) return { kind: 'unknown', text: raw }

  // ── session verbs ────────────────────────────────────────────────────────
  if (/^(undo|go back)\b/.test(text)) return { kind: 'undo' }
  if (/^redo\b/.test(text)) return { kind: 'redo' }
  if (/\b(clear|start over|new design|empty the scene)\b/.test(text)) return { kind: 'clear' }
  if (/\bhelp\b|what can (you|i)\b/.test(text)) return { kind: 'help' }
  if (/\bgrid\b/.test(text)) return { kind: 'grid' }
  if (/\b(import|load|open)\b.*\b(scan|file|stl|ply|mesh)\b/.test(text) || /^import\b/.test(text))
    return { kind: 'import' }
  if (/\b(export|download|print|save)\b/.test(text))
    return { kind: 'export', format: /\bply\b/.test(text) ? 'ply' : 'stl' }

  // ── arches ───────────────────────────────────────────────────────────────
  const arch = text.match(/\b(build|add|create|make|place)?\s*(an?\s+)?(upper|lower|full|both|complete)\s+(arch|arches|jaw|set)/)
  if (arch) {
    const which = arch[3]
    return { kind: 'arch', arch: which === 'upper' ? 'upper' : which === 'lower' ? 'lower' : 'both' }
  }
  if (/\b(all|every)\s+(32\s+)?(teeth|tooth)\b/.test(text)) return { kind: 'arch', arch: 'both' }

  // ── teeth ────────────────────────────────────────────────────────────────
  const toothNum = text.match(/\b(?:tooth|number|crown (?:for|on) tooth|crown (?:for|on))\s*#?\s*(\d{1,2})\b/)
  if (toothNum) {
    const n = num(toothNum[1])
    if (n !== null && n >= 1 && n <= 32) return { kind: 'addTooth', tooth: n }
  }
  for (const t of TOOTH_TYPES) {
    if (new RegExp(`\\b(add|create|make|place|build)\\b.*\\b${t}s?\\b`).test(text) || text === t)
      return { kind: 'addToothType', toothType: t }
  }

  // ── primitives (dimensions in mm) ────────────────────────────────────────
  const nums = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  if (/\b(box|cube|block|bar|plate)\b/.test(text))
    return { kind: 'primitive', shape: 'box', dims: nums.slice(0, 3) }
  if (/\b(cylinder|rod|post|pillar|disc|disk|tube)\b/.test(text))
    return { kind: 'primitive', shape: 'cylinder', dims: nums.slice(0, 2) }
  if (/\b(sphere|ball|dome|pearl)\b/.test(text))
    return { kind: 'primitive', shape: 'sphere', dims: nums.slice(0, 1) }

  // ── manipulate the current object ("it") ─────────────────────────────────
  const move = text.match(/\b(move|shift|slide|nudge)\b.*?\b(left|right|up|down|forward|forwards|back|backwards?)\b(?:\s*(?:by\s*)?(-?\d+(?:\.\d+)?))?/)
  if (move) {
    const dir = move[2]
    const mm = num(move[3]) ?? 5
    if (dir === 'left') return { kind: 'move', axis: 'x', mm: -mm }
    if (dir === 'right') return { kind: 'move', axis: 'x', mm }
    if (dir === 'up') return { kind: 'move', axis: 'y', mm }
    if (dir === 'down') return { kind: 'move', axis: 'y', mm: -mm }
    if (dir.startsWith('forward')) return { kind: 'move', axis: 'z', mm }
    return { kind: 'move', axis: 'z', mm: -mm }
  }
  const rot = text.match(/\b(rotate|turn|spin)\b(?:.*?\b(?:around|about|on)\s*(x|y|z)\b)?(?:.*?(-?\d+(?:\.\d+)?))?/)
  if (rot && /\b(rotate|turn|spin)\b/.test(text)) {
    return { kind: 'rotate', axis: (rot[2] as 'x' | 'y' | 'z') ?? 'y', deg: num(rot[3]) ?? 15 }
  }
  const scale = text.match(/\b(?:scale|resize)\b.*?(-?\d+(?:\.\d+)?)\s*(%|percent|x|times)?/)
  if (scale) {
    const v = num(scale[1]) ?? 1
    const pct = scale[2] === '%' || scale[2] === 'percent'
    return { kind: 'scale', factor: pct ? v / 100 : v }
  }
  if (/\b(bigger|larger|grow)\b/.test(text)) return { kind: 'scale', factor: 1.25 }
  if (/\b(smaller|shrink)\b/.test(text)) return { kind: 'scale', factor: 0.8 }

  const colorHex = text.match(/\b(?:color|colour|paint|make)\b.*?(#[0-9a-f]{6}|#[0-9a-f]{3})\b/)
  if (colorHex) return { kind: 'color', color: colorHex[1] }
  for (const [alias, hex] of Object.entries(COLOR_ALIASES)) {
    if (new RegExp(`\\b(color|colour|paint|make)\\b.*\\b${alias}\\b`).test(text))
      return { kind: 'color', color: hex }
  }
  for (const c of CSS_COLORS) {
    if (new RegExp(`\\b(color|colour|paint|make)\\b.*\\b${c}\\b`).test(text))
      return { kind: 'color', color: c === 'grey' ? 'gray' : c }
  }

  if (/\b(duplicate|copy|another one|again)\b/.test(text)) return { kind: 'duplicate' }
  if (/\b(delete|remove|drop)\b/.test(text)) return { kind: 'remove' }

  return { kind: 'unknown', text: raw }
}

/** Human-readable grammar summary, surfaced by the in-app help panel. */
export const GRAMMAR_HELP: ReadonlyArray<readonly [string, string]> = [
  ['build an upper arch', 'places every upper tooth from the library'],
  ['add tooth 14', 'one crown, seated at its arch position (Universal 1–32)'],
  ['add a molar / incisor / canine / premolar', 'nearest tooth of that class'],
  ['box 20 12 6 · cylinder 5 12 · sphere 8', 'primitives, sizes in mm'],
  ['move it left 5 · move it up', 'nudge the current object (mm)'],
  ['rotate it 30 · rotate it around x 90', 'degrees; y-axis by default'],
  ['scale it 120% · bigger · smaller', 'resize the current object'],
  ['color it gold · paint it wax', 'gold · ivory · teal · wax · gum · CSS colors'],
  ['duplicate it · delete it · clear', 'copy, remove, or start over'],
  ['import a scan', 'load an STL/PLY (a 3Shape arch export works)'],
  ['export stl', 'download the whole design, ready for a printer'],
  ['undo · redo · grid · help', 'session controls']
]
