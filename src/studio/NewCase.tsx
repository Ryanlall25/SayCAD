import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { parseGeometry } from '../core/meshConvert'
import { looksLikeLabCase, sihFromLabFiles } from '../core/labCase'
import { isSih, plyBinary, readSih, sihScanFileName } from '../core/sih'
import { fdiToUniversal } from '../crown/library'
import { unzip } from '../core/unzip'
import { MATERIALS, materialFromText, type MaterialId } from '../crown/materials'
import {
  assignToSlots,
  checkScan,
  jawOf,
  NEW_ORDER,
  occlusionWarning,
  orderFromProject,
  parseDentalProject,
  SCAN_FILE,
  scanSlots,
  SHADES,
  type CaseOrder,
  type ScanCheck,
  type ScanSlot,
  type ScanStats,
  type SlotId
} from '../crown/order'

/**
 * New crown in three swipeable cards: the tooth (with material and shade),
 * then one card per scan, asking for exactly the file needed at that
 * moment — the prep arch, then the opposing arch. Swiping forward is held
 * until the card has what it needs, and the deck says what that is. A
 * scanner .zip (or exocad .dentalProject) can fill everything at once.
 */

export interface LoadedScan {
  slot: SlotId
  name: string
  geometry: THREE.BufferGeometry
  stats: ScanStats
  check: ScanCheck
}

export interface NewCaseResult {
  order: CaseOrder
  scans: LoadedScan[]
}

type Card = { kind: 'tooth' } | { kind: 'scan'; slot: ScanSlot; n: number; of: number }

const MATERIAL_SHORT: Record<MaterialId, string> = {
  'zirconia-hs': 'Zirconia HS',
  'zirconia-ht': 'Zirconia HT',
  'lithium-disilicate': 'e.max (LS2)',
  'pmma-temp': 'PMMA temp',
  'cast-wax': 'Wax for casting'
}

const statsOf = (g: THREE.BufferGeometry): ScanStats => {
  g.computeBoundingBox()
  const b = g.boundingBox!
  const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3
  return { triangles: Math.round(tri), size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z], min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }
}

const vibrate = (ms: number): void => {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* not supported */
  }
}

const cardsFor = (slots: ScanSlot[]): Card[] => [{ kind: 'tooth' }, ...slots.map((slot, n) => ({ kind: 'scan' as const, slot, n: n + 1, of: slots.length }))]

export default function NewCase(props: {
  toothName: (n: number) => string
  onCancel: () => void
  onDone: (r: NewCaseResult) => void
}): React.JSX.Element {
  // Opposing scan always: the bite drives contacts and finding the prep.
  const [order, setOrder] = useState<CaseOrder>({ ...NEW_ORDER, antagonist: true, preop: false, bite: false })
  const [scans, setScans] = useState<Partial<Record<SlotId, LoadedScan>>>({})
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [nudge, setNudge] = useState(0) // bumps to replay the "needed" shake
  const [drag, setDrag] = useState(0)
  const [pending, setPending] = useState<File[] | null>(null) // scans dropped before the tooth was known
  const fileRef = useRef<HTMLInputElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)
  const pickFor = useRef<SlotId | null>(null)

  const toothName = order.tooth ? props.toothName(order.tooth) : ''
  const slots = useMemo(() => scanSlots(order, toothName), [order, toothName])
  const cards = useMemo(() => cardsFor(slots), [slots])
  const card = cards[Math.min(index, cards.length - 1)]
  const last = index === cards.length - 1

  // Picking the other jaw's tooth swaps which scan is the prep: start over.
  const jaw = order.tooth ? jawOf(order.tooth) : null
  const prevJaw = useRef(jaw)
  useEffect(() => {
    if (prevJaw.current && jaw && prevJaw.current !== jaw) setScans({})
    prevJaw.current = jaw
  }, [jaw])

  // Place held scans once the tooth (and so the jaws) is known.
  useEffect(() => {
    if (!pending || !slots.length) return
    setPending(null)
    void onFiles(pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, slots.length])

  /** What the card still needs before moving on, or null when it's complete. */
  function needed(c: Card): string | null {
    if (c.kind === 'tooth' && order.tooth === null) return 'Tap the tooth to restore.'
    if (c.kind === 'scan' && c.slot.required && !scans[c.slot.id]) return `Needed now: ${c.slot.title.toUpperCase()}.`
    return null
  }

  function go(to: number): void {
    const target = Math.max(0, Math.min(cards.length - 1, to))
    if (target > index && needed(cards[index])) {
      setNudge((x) => x + 1)
      vibrate(20)
      return
    }
    setIndex(target)
    vibrate(6)
  }

  /* ── swipe ────────────────────────────────────────────────────────── */
  const gesture = useRef<{ x: number; y: number; t: number; active: boolean; id: number } | null>(null)
  function onPointerDown(e: React.PointerEvent): void {
    if ((e.target as Element).closest('select, textarea, input[type=range]')) return
    gesture.current = { x: e.clientX, y: e.clientY, t: performance.now(), active: false, id: e.pointerId }
  }
  function onPointerMove(e: React.PointerEvent): void {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (!g.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null // a vertical scroll, not a swipe
        return
      }
      if (Math.abs(dx) < 10) return
      g.active = true
      deckRef.current?.setPointerCapture(e.pointerId)
    }
    const forwardBlocked = dx < 0 && needed(card) !== null
    const edge = (dx > 0 && index === 0) || (dx < 0 && last)
    setDrag(forwardBlocked || edge ? dx * 0.22 : dx)
  }
  function onPointerUp(e: React.PointerEvent): void {
    const g = gesture.current
    gesture.current = null
    if (!g || !g.active) return
    const dx = e.clientX - g.x
    const w = deckRef.current?.clientWidth || 360
    const v = dx / Math.max(1, performance.now() - g.t) // px/ms
    setDrag(0)
    if (dx < -w * 0.22 || v < -0.5) go(index + 1)
    else if (dx > w * 0.22 || v > 0.5) go(index - 1)
  }

  /* ── files ────────────────────────────────────────────────────────── */
  function choose(slot: SlotId | null): void {
    pickFor.current = slot
    fileRef.current?.click()
  }

  async function expand(list: File[]): Promise<{ files: File[]; project: string | null; sih: { tooth?: number; material?: string } | null }> {
    const files: File[] = []
    let project: string | null = null
    let sih: { tooth?: number; material?: string } | null = null
    for (const f of list) {
      if (isSih(f.name)) {
        // A whole case: its tooth and material, and each scan named by role and jaw.
        const c = await readSih(await f.arrayBuffer())
        const tooth = typeof c.case.tooth === 'number' ? (c.case.system === 'fdi' ? (fdiToUniversal(c.case.tooth) ?? undefined) : c.case.tooth) : undefined
        sih ??= { tooth, material: materialFromText(c.case.material) ?? undefined }
        for (const sc of c.scans) if (sc.role === 'prep' || sc.role === 'antagonist' || sc.role === 'bite' || sc.role === 'preop') files.push(new File([plyBinary(sc.geometry) as Uint8Array<ArrayBuffer>], sihScanFileName(sc)))
      } else if (/\.zip$/i.test(f.name)) {
        const entries = await unzip(await f.arrayBuffer(), (n) => SCAN_FILE.test(n) || /\.dentalProject$/i.test(n) || /(^|\/)case\.json$/i.test(n))
        // A lab case folder (jaws, die, case.json): read it as a case, like a .sih.
        const lab = looksLikeLabCase(entries.map((e) => e.name)) ? sihFromLabFiles(entries.map((e) => ({ name: e.name, data: e.data.buffer })), order.tooth ? { tooth: order.tooth } : {}) : null
        if (lab) {
          sih ??= { tooth: lab.case.tooth, material: materialFromText(lab.case.material) ?? undefined }
          for (const sc of lab.scans) if (sc.role === 'prep' || sc.role === 'antagonist') files.push(new File([plyBinary(sc.geometry) as Uint8Array<ArrayBuffer>], sihScanFileName(sc)))
          continue
        }
        for (const e of entries) {
          if (/(^|\/)case\.json$/i.test(e.name)) continue
          const base = e.name.split('/').pop()!
          if (/\.dentalProject$/i.test(base)) project ??= new TextDecoder().decode(e.data)
          else files.push(new File([e.data], base))
        }
      } else if (/\.dentalProject$/i.test(f.name)) project ??= await f.text()
      else if (SCAN_FILE.test(f.name)) files.push(f)
    }
    return { files, project, sih }
  }

  async function load(f: File, slot: ScanSlot): Promise<LoadedScan> {
    const geometry = await parseGeometry(f)
    const stats = statsOf(geometry)
    return { slot: slot.id, name: f.name, geometry, stats, check: checkScan(f.name, stats, slot) }
  }

  async function onFiles(picked: File[]): Promise<void> {
    if (!picked.length) return
    setBusy('Reading…')
    setNote(null)
    try {
      const { files, project, sih } = await expand(picked)
      let currentSlots = slots
      if (sih?.tooth) {
        const o = { ...order, tooth: sih.tooth, ...(sih.material && sih.material in MATERIALS ? { material: sih.material as MaterialId } : {}), antagonist: true, preop: false, bite: false }
        setOrder(o)
        setNote(`Case file: #${sih.tooth}${sih.material ? ` · ${MATERIALS[sih.material as MaterialId]?.label ?? sih.material}` : ''}.`)
        currentSlots = scanSlots(o, props.toothName(o.tooth))
      }
      if (project && !sih?.tooth) {
        const r = orderFromProject(parseDentalProject(project), order)
        const o = { ...r.order, antagonist: true, preop: false, bite: false }
        setOrder(o)
        setNote(r.note)
        currentSlots = scanSlots(o, o.tooth ? props.toothName(o.tooth) : '')
      }
      if (!files.length) {
        if (!project) setNote('No STL or PLY scans in that selection.')
        return
      }
      if (!currentSlots.length) {
        setPending(files)
        setNote(`${files.length} scan file${files.length > 1 ? 's' : ''} held. Tap the tooth — it decides which jaw is the prep.`)
        setIndex(0)
        return
      }
      // One file → the card it was picked on. Several → sorted by name.
      const target = pickFor.current ? currentSlots.find((s) => s.id === pickFor.current) : undefined
      const plan: Partial<Record<SlotId, string>> =
        files.length === 1 && target ? { [target.id]: files[0].name } : assignToSlots(files.map((f) => f.name), currentSlots, files.length === 1 ? scans : {})
      const next: Partial<Record<SlotId, LoadedScan>> = {}
      for (const [id, name] of Object.entries(plan) as Array<[SlotId, string]>) {
        const slot = currentSlots.find((s) => s.id === id)!
        setBusy(`Reading ${name}…`)
        next[id] = await load(files.find((f) => f.name === name)!, slot)
      }
      const placed = Object.keys(next).length
      if (!placed) {
        setNote(`Couldn't tell which scan ${files.length === 1 ? 'that is' : 'those are'} — choose it on its card.`)
        return
      }
      const merged = { ...scans, ...next }
      setScans(merged)
      const unplaced = files.length - placed
      if (unplaced > 0) setNote(`${placed} scan${placed > 1 ? 's' : ''} placed; ${unplaced} file${unplaced > 1 ? 's' : ''} not needed.`)
      vibrate(10)
      // Show the next scan still needed — or the last card, where Design Crown is.
      const warned = (Object.values(next) as LoadedScan[]).find((x) => x.check.warnings.length)
      const all = cardsFor(currentSlots)
      const to = warned
        ? all.findIndex((c) => c.kind === 'scan' && c.slot.id === warned.slot)
        : Math.max(0, all.findIndex((c) => c.kind === 'scan' && c.slot.required && !merged[c.slot.id]))
      window.setTimeout(() => setIndex(to > 0 ? to : all.length - 1), warned ? 0 : 450)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      pickFor.current = null
    }
  }

  function finish(): void {
    const stop = cards.findIndex((c) => needed(c) !== null)
    if (stop >= 0) {
      setIndex(stop)
      setNudge((x) => x + 1)
      return
    }
    props.onDone({ order, scans: slots.map((s) => scans[s.id]).filter((x): x is LoadedScan => !!x) })
  }

  /* ── render ───────────────────────────────────────────────────────── */
  const set = <K extends keyof CaseOrder>(k: K, v: CaseOrder[K]): void => setOrder((o) => ({ ...o, [k]: v }))
  const need = needed(card)
  const bite = scans.prep && scans.antagonist ? occlusionWarning(scans.prep.stats, scans.antagonist.stats) : null

  function primary(): { label: string; run: () => void } {
    if (card.kind === 'scan' && !scans[card.slot.id]) return { label: `Choose ${card.slot.title}`, run: () => choose(card.slot.id) }
    if (last && card.kind === 'scan') return { label: 'Design Crown', run: finish }
    return { label: 'Continue', run: () => go(index + 1) }
  }
  const p = primary()

  return (
    <div className="nc" role="dialog" aria-label="New crown">
      <header className="nc-top">
        <button className="st-link" onClick={props.onCancel}>Cancel</button>
        <b>New Crown</b>
        <span className="nc-count">{index + 1}/{cards.length}</span>
      </header>
      <div className="nc-progress" aria-hidden>
        {cards.map((c, k) => (
          <span key={k} className={k < index ? 'done' : k === index ? 'on' : ''} />
        ))}
      </div>

      <div
        className="nc-deck"
        ref={deckRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null
          setDrag(0)
        }}
      >
        <div className={`nc-track ${drag ? 'dragging' : ''}`} style={{ transform: `translateX(calc(${-index * 100}% + ${drag}px))` }}>
          {cards.map((c, k) => (
            <section key={`${c.kind}-${c.kind === 'scan' ? c.slot.id : k}`} className="nc-card" aria-hidden={k !== index} inert={k !== index ? true : undefined}>
              {c.kind === 'tooth' && (
                <>
                  <h1>{order.tooth ? `#${order.tooth} · ${toothName}` : 'Which tooth?'}</h1>
                  <ArchChart selected={order.tooth} onPick={(n) => { set('tooth', n); vibrate(6) }} />
                  <div className="nc-chips" role="group" aria-label="Material">
                    {(Object.keys(MATERIALS) as MaterialId[]).map((m) => (
                      <button key={m} className={order.material === m ? 'on' : ''} onClick={() => set('material', m)}>{MATERIAL_SHORT[m]}</button>
                    ))}
                  </div>
                  <div className="nc-inline">
                    <label>Shade
                      <select value={order.shade} onChange={(e) => set('shade', e.target.value)}>
                        {SHADES.map((x) => <option key={x}>{x}</option>)}
                      </select>
                    </label>
                    <input value={order.patient} onChange={(e) => set('patient', e.target.value)} placeholder="Patient / case (optional)" autoComplete="off" aria-label="Patient" />
                  </div>
                  <button className="st-link nc-import" onClick={() => choose(null)}>Have a .sih case or the whole scanner export? Import it</button>
                </>
              )}

              {c.kind === 'scan' && (
                <>
                  <ScanCard slot={c.slot} n={c.n} of={c.of} tooth={order.tooth} scan={scans[c.slot.id]} onChoose={() => choose(c.slot.id)} />
                  {c.slot.id === 'antagonist' && bite && <p className="nc-warn">{bite}</p>}
                </>
              )}
            </section>
          ))}
        </div>
      </div>

      <footer className="nc-bottom">
        {note && <p className="nc-note">{note}</p>}
        {need && <p key={nudge} className={`nc-need ${nudge ? 'shake' : ''}`}>{need}</p>}
        <div className="nc-nav">
          <button className="st-btn tinted" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Back">‹</button>
          <button className="st-btn primary" onClick={p.run} disabled={!!busy}>{busy ?? p.label}</button>
        </div>
      </footer>

      {/* No `accept` filter: iOS greys out files whose type it doesn't know (.stl, .dentalProject); names are checked after picking. */}
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void onFiles(f) }} />
    </div>
  )
}

function ScanCard(props: { slot: ScanSlot; n: number; of: number; tooth: number | null; scan?: LoadedScan; onChoose: () => void }): React.JSX.Element {
  const { slot, scan } = props
  return (
    <>
      <p className="st-eyebrow">Scan {props.n} of {props.of}</p>
      <h1>{slot.title}</h1>
      <ArchChart selected={props.tooth} highlight={slot.jaw} compact />
      <p className="nc-ask">{slot.ask}</p>
      <p className="st-foot">{slot.hint}</p>
      {scan ? (
        <div className="st-group nc-file">
          <div className="nc-file-row">
            <span className={`nc-dot ${scan.check.warnings.length ? 'warn' : 'ok'}`} />
            <span className="nc-file-main"><b>{scan.name}</b><span>{scan.check.summary}</span></span>
          </div>
          {scan.check.warnings.map((w) => <p key={w} className="nc-warn">{w}</p>)}
          <div className="st-actions">
            <button className="st-btn tinted" onClick={props.onChoose}>Replace</button>
          </div>
        </div>
      ) : (
        <button className="nc-drop" onClick={props.onChoose}>
          <span>＋</span>
          Tap to choose the file
          <small>STL · PLY · OBJ · a .sih case · or the whole export as .zip</small>
        </button>
      )}
    </>
  )
}

/* ── arch chart ──────────────────────────────────────────────────────── */

// Mesiodistal widths (mm) from central incisor to third molar — sizes the circles.
const UPPER_W = [8.5, 6.5, 7.5, 7, 6.5, 10, 9, 8.5]
const LOWER_W = [5.4, 5.9, 6.9, 7, 7.1, 11, 10.5, 10]

interface ToothPos { n: number; x: number; y: number; r: number }

function archLayout(): ToothPos[] {
  const out: ToothPos[] = []
  const place = (widths: number[], upper: boolean): void => {
    // Patient right on screen left: quadrant from midline outwards, both sides.
    const total = widths.reduce((a, b) => a + b, 0)
    const cx = 170
    const cy = upper ? 168 : 192
    const rx = 128
    const ry = 128
    for (const side of [-1, 1]) {
      let acc = 0
      widths.forEach((w, k) => {
        const mid = (acc + w / 2) / total
        acc += w
        const theta = (Math.PI / 2) * (1 - mid * 0.92) // 90° at the midline → ~8° at the third molar
        const x = cx + side * rx * Math.cos(theta)
        const y = upper ? cy - ry * Math.sin(theta) : cy + ry * Math.sin(theta)
        // Universal: upper 1 (right 3rd molar) → 16; lower 17 (left 3rd molar) → 32.
        const n = upper ? (side < 0 ? 8 - k : 9 + k) : side < 0 ? 25 + k : 24 - k
        out.push({ n, x, y, r: w * 1.32 })
      })
    }
  }
  place(UPPER_W, true)
  place(LOWER_W, false)
  return out
}
const ARCH = archLayout()

function ArchChart(props: { selected: number | null; onPick?: (n: number) => void; highlight?: 'upper' | 'lower' | 'both' | null; dashed?: boolean; compact?: boolean }): React.JSX.Element {
  const lit = (n: number): boolean => props.highlight === 'both' || (props.highlight === 'upper' && n <= 16) || (props.highlight === 'lower' && n > 16)
  const dim = props.highlight !== undefined && props.highlight !== null
  return (
    <svg className={`nc-arch ${props.compact ? 'compact' : ''} `} viewBox="0 18 340 324" role={props.onPick ? 'group' : 'img'} aria-label={props.onPick ? 'Tooth chart' : `${props.highlight ?? ''} jaw`}>
      <text x="170" y="174" className="nc-arch-label">Upper</text>
      <text x="170" y="196" className="nc-arch-label">Lower</text>
      <text x="16" y="182" className="nc-arch-side">R</text>
      <text x="324" y="182" className="nc-arch-side">L</text>
      {ARCH.map((t) => {
        const sel = props.selected === t.n
        const cls = ['nc-tooth', sel ? 'sel' : '', dim ? (lit(t.n) ? 'lit' : 'dim') : '', props.dashed && lit(t.n) ? 'dashed' : ''].join(' ')
        return (
          <g key={t.n} className={cls} onClick={props.onPick ? () => props.onPick!(t.n) : undefined} role={props.onPick ? 'button' : undefined} aria-label={props.onPick ? `Tooth ${t.n}` : undefined} aria-pressed={props.onPick ? sel : undefined}>
            {props.onPick && <circle className="nc-hit" cx={t.x} cy={t.y} r={Math.max(t.r, 15)} />}
            <circle cx={t.x} cy={t.y} r={t.r} />
            {!props.compact && <text x={t.x} y={t.y + 4}>{t.n}</text>}
          </g>
        )
      })}
    </svg>
  )
}
