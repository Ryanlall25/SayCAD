/**
 * The crown-department command grammar — what a technician can say or type
 * in Crown Studio. Same discipline as parser.ts: a pure function from one
 * sentence to one structured command, every phrase pinned by a test. The
 * Claude layer (src/ai) compiles free speech into exactly these commands via
 * tools, so typed, spoken and AI-driven edits all run through one executor.
 */
import type { MaterialId } from '../crown/materials'
import { normalize } from './parser'

export type NumericParam =
  | 'contactMesialMm'
  | 'contactDistalMm'
  | 'occlusalClearanceMm'
  | 'cuspScale'
  | 'grooveScale'
  | 'buccalBulgeMm'
  | 'lingualBulgeMm'
  | 'heightOffsetMm'
  | 'rotationDeg'
  | 'mdShiftMm'
  | 'blShiftMm'
  | 'cementGapMm'
  | 'axisTiltMesialDeg'
  | 'axisTiltBuccalDeg'

export type CrownView = 'occlusal' | 'buccal' | 'lingual' | 'mesial' | 'distal' | 'fit'
export type CrownLayer = 'antagonist' | 'scan' | 'heatmap' | 'margin' | 'crown'

export const SCULPT_REGIONS = [
  'mesial-contact',
  'distal-contact',
  'buccal-wall',
  'lingual-wall',
  'mesial-marginal-ridge',
  'distal-marginal-ridge',
  'central-fossa',
  'occlusal-table',
  'mesiobuccal',
  'distobuccal',
  'distal',
  'mesiolingual',
  'distolingual',
  'buccal',
  'lingual',
  'cusp tip',
  'incisal edge'
] as const

export type CrownCommand =
  | { kind: 'setTooth'; tooth: number }
  | { kind: 'autoDesign' }
  | { kind: 'param'; param: NumericParam; mode: 'set' | 'change'; value: number }
  | { kind: 'material'; material: MaterialId }
  | { kind: 'occlusalContacts'; on: boolean }
  | { kind: 'sculpt'; region: string; amountMm: number; radiusMm: number }
  | { kind: 'flipBuccal' }
  | { kind: 'view'; view: CrownView }
  | { kind: 'layer'; layer: CrownLayer; visible: boolean | 'toggle' }
  | { kind: 'check' }
  | { kind: 'export' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'demo' }
  | { kind: 'review' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string }

export const MATERIAL_WORDS: Array<[RegExp, MaterialId]> = [
  [/\b(5y|high translucen\w*|ht zirconia|translucent zirconia)\b/, 'zirconia-ht'],
  [/\b(zirconia|zirc|zr|bruxzir|full contour)\b/, 'zirconia-hs'],
  [/\b(e ?max|emax|lithium( disilicate)?|disilicate)\b/, 'lithium-disilicate'],
  [/\b(pmma|temp(orary)?|provisional)\b/, 'pmma-temp'],
  [/\b(gold|full cast|cast|wax pattern)\b/, 'cast-wax']
]

/** Spoken amounts: "0.2", "point two", "20 microns", "a bit" (= default). */
function amountMm(text: string, dflt: number): number {
  const micron = /(\d+(?:\.\d+)?)\s*(?:microns?|µm|um)\b/.exec(text)
  if (micron) return Number(micron[1]) / 1000
  const pointWord = /\bpoint (\d+)\b/.exec(text)
  if (pointWord) return Number(`0.${pointWord[1]}`)
  const n = /(-?\d*\.?\d+)\s*(?:mm|millimet\w*)?/.exec(text.replace(/\btooth \d+\b/, ''))
  if (n && n[1] !== '.') return Math.abs(Number(n[1]))
  if (/\b(a lot|much|lots)\b/.test(text)) return dflt * 2.5
  if (/\b(tiny|hair|touch|slightly)\b/.test(text)) return dflt / 2
  return dflt
}

const CUSP_ALIASES: Array<[RegExp, string]> = [
  [/\b(mesio ?buccal|mb)\b/, 'mesiobuccal'],
  [/\b(disto ?buccal|db)\b/, 'distobuccal'],
  [/\b(mesio ?lingual|ml|mesio ?palatal)\b/, 'mesiolingual'],
  [/\b(disto ?lingual|dl|disto ?palatal)\b/, 'distolingual'],
  [/\bmesial (marginal )?ridge\b/, 'mesial-marginal-ridge'],
  [/\bdistal (marginal )?ridge\b/, 'distal-marginal-ridge'],
  [/\b(central )?fossa\b/, 'central-fossa'],
  [/\bbuccal (wall|contour|surface)\b/, 'buccal-wall'],
  [/\b(lingual|palatal) (wall|contour|surface)\b/, 'lingual-wall'],
  [/\bbuccal cusp\b/, 'buccal'],
  [/\b(lingual|palatal) cusp\b/, 'lingual'],
  [/\bdistal cusp\b/, 'distal'],
  [/\bcusp tip\b/, 'cusp tip'],
  [/\bincisal edge\b/, 'incisal edge']
]

export function parseCrown(raw: string): CrownCommand {
  const text = normalize(raw)
  if (!text) return { kind: 'unknown', text: raw }

  if (/^(undo|go back)\b/.test(text)) return { kind: 'undo' }
  if (/^redo\b/.test(text)) return { kind: 'redo' }
  if (/\bhelp\b|what can (you|i) (say|do)\b/.test(text)) return { kind: 'help' }
  if (/\b(demo|sample|example) case\b|\bload (the )?demo\b/.test(text)) return { kind: 'demo' }
  if (/\bflip (the )?buccal\b|buccal is (the )?other (way|side)|wrong side\b/.test(text)) return { kind: 'flipBuccal' }
  if (/\b(ai )?review\b|\bwhat do you think\b/.test(text)) return { kind: 'review' }
  if (/\b(export|download|save|send)\b.*\b(stl|crown|design|file|mill)\b|^export\b/.test(text)) return { kind: 'export' }
  if (/^(check|run checks|qc|quality check|is it ok)\b/.test(text)) return { kind: 'check' }

  const tooth = /\b(?:tooth|number|#)\s*(\d{1,2})\b/.exec(text)
  if (tooth && Number(tooth[1]) >= 1 && Number(tooth[1]) <= 32 && !/\b(add|remove|reduce|raise|lower)\b/.test(text)) {
    return { kind: 'setTooth', tooth: Number(tooth[1]) }
  }
  if (/\b(auto ?design|design (it|the crown|this)|make (the|a) crown|redesign|start over)\b/.test(text)) return { kind: 'autoDesign' }

  // Material.
  if (/\b(material|make it|switch to|use|in)\b/.test(text) || MATERIAL_WORDS.some(([re]) => re.test(text))) {
    for (const [re, id] of MATERIAL_WORDS) if (re.test(text) && !/\bcement\b/.test(text)) return { kind: 'material', material: id }
  }

  // Views & layers.
  const view = /\b(?:show|view|look at|from|turn to)\b.*\b(occlusal|buccal|lingual|palatal|mesial|distal)\b(?! contact| cusp| ridge| wall)/.exec(text)
  if (view) return { kind: 'view', view: (view[1] === 'palatal' ? 'lingual' : view[1]) as CrownView }
  if (/\b(fit|reset) (the )?view\b|\bzoom (to )?fit\b/.test(text)) return { kind: 'view', view: 'fit' }
  const layer = /\b(show|hide|toggle)\b.*\b(antagonist|opposing|bite|scan|heat ?map|thickness|margin|crown)\b/.exec(text)
  if (layer) {
    const map: Record<string, CrownLayer> = { antagonist: 'antagonist', opposing: 'antagonist', bite: 'antagonist', scan: 'scan', heatmap: 'heatmap', 'heat map': 'heatmap', thickness: 'heatmap', margin: 'margin', crown: 'crown' }
    return { kind: 'layer', layer: map[layer[2]], visible: layer[1] === 'toggle' ? 'toggle' : layer[1] === 'show' }
  }

  // Occlusal contacts on/off.
  if (/\b(out of occlusion|no occlusal contacts|infra ?occlusion)\b/.test(text)) return { kind: 'occlusalContacts', on: false }
  if (/\b(in occlusion|occlusal contacts on|add occlusal (stops|contacts))\b/.test(text)) return { kind: 'occlusalContacts', on: true }

  // Contacts.
  const contact = /\b(mesial|distal|both|proximal)?\s*contacts?\b/.exec(text)
  if (contact && /\b(tight\w*|loose\w*|open\w*|close\w*|heav\w*|light\w*|strong\w*|weak\w*)\b/.test(text)) {
    const tighter = /\b(tight\w*|close\w*|heav\w*|strong\w*)\b/.test(text)
    const d = amountMm(text, 0.02) * (tighter ? -1 : 1)
    const side = contact[1] ?? (/\bmesial\b/.test(text) ? 'mesial' : /\bdistal\b/.test(text) ? 'distal' : 'both')
    if (side === 'mesial') return { kind: 'param', param: 'contactMesialMm', mode: 'change', value: d }
    if (side === 'distal') return { kind: 'param', param: 'contactDistalMm', mode: 'change', value: d }
    return { kind: 'param', param: 'contactMesialMm', mode: 'change', value: d }
  }

  // Cement gap.
  const gap = /\bcement (gap|space)\b/.exec(text)
  if (gap) {
    const v = amountMm(text, 0.06)
    return { kind: 'param', param: 'cementGapMm', mode: 'set', value: v }
  }

  // Occlusal clearance / height.
  if (/\b(high|hitting|too tall|in hyper ?occlusion)\b/.test(text) && /\b(it'?s|crown|is|too)\b/.test(text)) {
    return { kind: 'param', param: 'occlusalClearanceMm', mode: 'change', value: amountMm(text, 0.05) }
  }
  if (/\bocclusal clearance\b/.test(text)) return { kind: 'param', param: 'occlusalClearanceMm', mode: 'set', value: amountMm(text, 0.05) }

  // Sculpt a named region.
  for (const [re, region] of CUSP_ALIASES) {
    if (!re.test(text)) continue
    if (/\b(add|build ?up|raise|taller|bigger|more|bulk|thicken)\b/.test(text)) return { kind: 'sculpt', region, amountMm: amountMm(text, 0.15), radiusMm: 1.5 }
    if (/\b(remove|reduce|lower|shorter|smaller|less|grind|thin)\b/.test(text)) return { kind: 'sculpt', region, amountMm: -amountMm(text, 0.15), radiusMm: 1.5 }
  }

  // Whole-crown anatomy.
  if (/\bcusps?\b/.test(text)) {
    if (/\b(more|taller|sharper|steeper|pronounced|higher|deeper)\b/.test(text)) return { kind: 'param', param: 'cuspScale', mode: 'change', value: 0.1 }
    if (/\b(less|flatter|flat|lower|shallower|softer|smaller)\b/.test(text)) return { kind: 'param', param: 'cuspScale', mode: 'change', value: -0.1 }
  }
  if (/\bgrooves?\b/.test(text)) {
    if (/\b(deeper|more|sharper)\b/.test(text)) return { kind: 'param', param: 'grooveScale', mode: 'change', value: 0.25 }
    if (/\b(shallower|less|softer|smooth\w*)\b/.test(text)) return { kind: 'param', param: 'grooveScale', mode: 'change', value: -0.25 }
  }
  const bulge = /\b(buccal|lingual|palatal)\b.*\b(fuller|bulkier|more|thinner|less|flatter|bulge)\b|\b(fuller|bulkier|thinner|flatter)\b.*\b(buccal|lingual|palatal)\b/.exec(text)
  if (bulge) {
    const side = (bulge[1] ?? bulge[4]) === 'buccal' ? 'buccalBulgeMm' : 'lingualBulgeMm'
    const more = /\b(fuller|bulkier|more|bulge)\b/.test(text) && !/\b(less|thinner|flatter)\b/.test(text)
    return { kind: 'param', param: side, mode: 'change', value: amountMm(text, 0.15) * (more ? 1 : -1) }
  }
  const raise = /\b(raise|lower|drop|lift)\b.*\b(crown|occlusal|table|it)\b|\b(taller|shorter)\b/.exec(text)
  if (raise) {
    const up = /\b(raise|lift|taller)\b/.test(text)
    return { kind: 'param', param: 'heightOffsetMm', mode: 'change', value: amountMm(text, 0.1) * (up ? 1 : -1) }
  }
  const tilt = /\b(tilt|lean)\b.*\b(axis|insertion|path)?.*\b(mesial\w*|distal\w*|buccal\w*|lingual\w*|palatal\w*)\b/.exec(text)
  if (tilt && /\b(axis|insertion|path)\b/.test(text)) {
    const n = /(\d+(?:\.\d+)?)/.exec(text)
    const deg = n ? Number(n[1]) : 2
    const dir = tilt[3]
    if (/^mesial/.test(dir)) return { kind: 'param', param: 'axisTiltMesialDeg', mode: 'change', value: deg }
    if (/^distal/.test(dir)) return { kind: 'param', param: 'axisTiltMesialDeg', mode: 'change', value: -deg }
    if (/^buccal/.test(dir)) return { kind: 'param', param: 'axisTiltBuccalDeg', mode: 'change', value: deg }
    return { kind: 'param', param: 'axisTiltBuccalDeg', mode: 'change', value: -deg }
  }
  if (/\brotate\b/.test(text)) {
    const n = /(-?\d+(?:\.\d+)?)/.exec(text)
    const deg = n ? Math.abs(Number(n[1])) : 3
    const neg = /\b(counter ?clockwise|anti ?clockwise|distal\w*)\b/.test(text) || (n !== null && Number(n[1]) < 0)
    return { kind: 'param', param: 'rotationDeg', mode: 'change', value: neg ? -deg : deg }
  }
  const shift = /\b(shift|move|slide)\b.*\b(mesial\w*|distal\w*|buccal\w*|lingual\w*|palatal\w*)\b/.exec(text)
  if (shift) {
    const dir = shift[2]
    const v = amountMm(text, 0.1)
    if (/^mesial/.test(dir)) return { kind: 'param', param: 'mdShiftMm', mode: 'change', value: v }
    if (/^distal/.test(dir)) return { kind: 'param', param: 'mdShiftMm', mode: 'change', value: -v }
    if (/^buccal/.test(dir)) return { kind: 'param', param: 'blShiftMm', mode: 'change', value: v }
    return { kind: 'param', param: 'blShiftMm', mode: 'change', value: -v }
  }
  return { kind: 'unknown', text: raw }
}

export const CROWN_HELP: ReadonlyArray<readonly [string, string]> = [
  ['tooth 19', 'pick the tooth (Universal 1–32)'],
  ['auto design', 'margin → crown → checks in one go'],
  ['tighter mesial contact', 'contact 0.02 mm tighter (say an amount to override)'],
  ['open the distal contact 0.05', 'relieve the distal contact'],
  ['it’s high', 'more occlusal clearance'],
  ['add 0.2 to the mesiobuccal cusp', 'sculpt a named cusp / ridge / wall'],
  ['flatter cusps · deeper grooves', 'whole-crown anatomy'],
  ['fuller buccal', 'more buccal contour'],
  ['raise the crown 0.1', 'occlusal table up/down'],
  ['rotate 5 degrees', 'rotate the anatomy about the insertion axis'],
  ['tilt the insertion axis 3 degrees mesial', 'change the path of insertion (less blockout)'],
  ['zirconia · emax · pmma · gold', 'material (sets thickness minimums and cement gap)'],
  ['cement gap 60 microns', 'cement space'],
  ['flip buccal', 'if the buccal arrow points to the tongue'],
  ['show occlusal · hide antagonist · show thickness', 'views and layers'],
  ['check · review · export stl', 'QC, AI review, download'],
  ['undo · redo', 'step through design history']
]
