import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { parseGeometry } from '../core/meshConvert'
import { unzip } from '../core/unzip'
import { MATERIALS, type MaterialId } from '../crown/materials'
import {
  assignToSlots,
  checkScan,
  jawOf,
  NEW_ORDER,
  occlusionWarning,
  orderFromProject,
  parseDentalProject,
  RESTORATIONS,
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
 * New case, the way exocad's DentalDB builds an order — patient, tooth,
 * restoration, which scans exist — then one card per scan, asking for
 * exactly the file needed at that moment. Cards swipe like iOS pages;
 * swiping forward is held until the current card has what it needs, and
 * the deck says what that is.
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

type Card = { kind: 'start' } | { kind: 'tooth' } | { kind: 'restoration' } | { kind: 'scans' } | { kind: 'scan'; slot: ScanSlot; n: number; of: number } | { kind: 'review' }

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

export default function NewCase(props: {
  toothName: (n: number) => string
  onCancel: () => void
  onDone: (r: NewCaseResult) => void
}): React.JSX.Element {
  const [order, setOrder] = useState<CaseOrder>({ ...NEW_ORDER })
  const [scans, setScans] = useState<Partial<Record<SlotId, LoadedScan>>>({})
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [nudge, setNudge] = useState(0) // bumps to replay the "needed" shake
  const [drag, setDrag] = useState(0)
  const [pending, setPending] = useState<File[] | null>(null) // scans dropped before the tooth was known
  const fileRef = useRef<HTMLInputElement>(null)
  const projectRef = useRef<HTMLInputElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)
  const pickFor = useRef<SlotId | null>(null)

  const toothName = order.tooth ? props.toothName(order.tooth) : ''
  const slots = useMemo(() => scanSlots(order, toothName), [order, toothName])
  const cards: Card[] = useMemo(
    () => [
      { kind: 'start' },
      { kind: 'tooth' },
      { kind: 'restoration' },
      { kind: 'scans' },
      ...slots.map((slot, n) => ({ kind: 'scan' as const, slot, n: n + 1, of: slots.length })),
      { kind: 'review' }
    ],
    [slots]
  )
  const card = cards[Math.min(index, cards.length - 1)]

  // Drop scans whose slot no longer exists (e.g. pre-op switched off).
  useEffect(() => {
    setScans((s) => {
      const ids = new Set(slots.map((x) => x.id))
      const next = Object.fromEntries(Object.entries(s).filter(([k]) => ids.has(k as SlotId)))
      return Object.keys(next).length === Object.keys(s).length ? s : next
    })
  }, [slots])

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
    if (c.kind === 'restoration' && !RESTORATIONS.find((r) => r.id === order.restoration)?.ready) return 'Only anatomic crowns can be designed so far.'
    if (c.kind === 'scan' && c.slot.required && !scans[c.slot.id]) return `Needed now: ${c.slot.title.toUpperCase()}.`
    return null
  }
  const blockedAt = (): number => cards.findIndex((c) => needed(c) !== null)

  function go(to: number): void {
    const target = Math.max(0, Math.min(cards.length - 1, to))
    if (target > index) {
      const need = needed(cards[index])
      if (need) {
        setNudge((x) => x + 1)
        vibrate(20)
        return
      }
    }
    setIndex(target)
    vibrate(6)
  }

  /* ── swipe ────────────────────────────────────────────────────────── */
  const gesture = useRef<{ x: number; y: number; t: number; active: boolean; id: number } | null>(null)
  function onPointerDown(e: React.PointerEvent): void {
    if ((e.target as Element).closest('select, textarea, input[type=range], input[type=date]')) return
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
    const edge = (dx > 0 && index === 0) || (dx < 0 && index === cards.length - 1)
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

  async function expand(list: File[]): Promise<{ files: File[]; project: string | null }> {
    const files: File[] = []
    let project: string | null = null
    for (const f of list) {
      if (/\.zip$/i.test(f.name)) {
        const entries = await unzip(await f.arrayBuffer(), (n) => SCAN_FILE.test(n) || /\.dentalProject$/i.test(n))
        for (const e of entries) {
          const base = e.name.split('/').pop()!
          if (/\.dentalProject$/i.test(base)) project ??= new TextDecoder().decode(e.data)
          else files.push(new File([e.data], base))
        }
      } else if (/\.dentalProject$/i.test(f.name)) project ??= await f.text()
      else if (SCAN_FILE.test(f.name)) files.push(f)
    }
    return { files, project }
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
      const { files, project } = await expand(picked)
      let currentSlots = slots
      if (project) {
        const r = orderFromProject(parseDentalProject(project), order)
        setOrder(r.order)
        setNote(r.note)
        currentSlots = scanSlots(r.order, r.order.tooth ? props.toothName(r.order.tooth) : '')
      }
      if (!files.length) {
        if (!project) setNote('No STL or PLY scans in that selection.')
        return
      }
      if (!currentSlots.length) {
        setPending(files)
        setNote(`${files.length} scan file${files.length > 1 ? 's' : ''} held. Pick the tooth — it decides which jaw is the prep scan.`)
        setIndex(1)
        return
      }
      // One file → the slot it was picked for. Several → sorted by name.
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
        setNote(`Couldn't tell which scan ${files.length === 1 ? 'that is' : 'those are'} — open a scan card and choose the file there.`)
        return
      }
      const merged = { ...scans, ...next }
      setScans(merged)
      const unplaced = files.length - placed
      if (unplaced > 0) setNote(`${placed} scan${placed > 1 ? 's' : ''} placed; ${unplaced} file${unplaced > 1 ? 's' : ''} not needed for this case.`)
      vibrate(10)
      // Move on to the next scan still needed — unless this one needs a look.
      const warn = Object.values(next).some((s) => s && s.check.warnings.length)
      if (!warn) {
        const allCards = cardsFor(currentSlots)
        const firstMissing = allCards.findIndex((c) => c.kind === 'scan' && c.slot.required && !merged[c.slot.id])
        const here = allCards.findIndex((c) => c.kind === 'scan' && c.slot.id === (pickFor.current ?? Object.keys(next)[0]))
        const to = firstMissing >= 0 ? firstMissing : files.length > 1 || here < 0 ? allCards.length - 1 : here + 1
        window.setTimeout(() => setIndex(to), 450)
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      pickFor.current = null
    }
  }

  const cardsFor = (s: ScanSlot[]): Card[] => [
    { kind: 'start' },
    { kind: 'tooth' },
    { kind: 'restoration' },
    { kind: 'scans' },
    ...s.map((slot, n) => ({ kind: 'scan' as const, slot, n: n + 1, of: s.length })),
    { kind: 'review' }
  ]

  async function onProject(f: File | undefined): Promise<void> {
    if (!f) return
    await onFiles([f])
  }

  function finish(): void {
    const stop = blockedAt()
    if (stop >= 0 && stop < cards.length - 1) {
      setIndex(stop)
      setNudge((x) => x + 1)
      return
    }
    props.onDone({ order, scans: slots.map((s) => scans[s.id]).filter((x): x is LoadedScan => !!x) })
  }

  /* ── render ───────────────────────────────────────────────────────── */
  const set = <K extends keyof CaseOrder>(k: K, v: CaseOrder[K]): void => setOrder((o) => ({ ...o, [k]: v }))
  const need = needed(card)
  const prep = scans.prep
  const ant = scans.antagonist
  const bite = prep && ant ? occlusionWarning(prep.stats, ant.stats) : null

  function primary(): { label: string; run: () => void } {
    if (card.kind === 'scan' && !scans[card.slot.id]) return { label: `Choose ${card.slot.title}`, run: () => choose(card.slot.id) }
    if (card.kind === 'review') return { label: 'Design Crown', run: finish }
    if (card.kind === 'scan' && !card.slot.required && !scans[card.slot.id]) return { label: 'Skip', run: () => go(index + 1) }
    return { label: 'Continue', run: () => go(index + 1) }
  }
  const p = primary()

  return (
    <div className="nc" role="dialog" aria-label="New case">
      <header className="nc-top">
        <button className="st-link" onClick={props.onCancel}>Cancel</button>
        <b>New Case</b>
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
              {c.kind === 'start' && (
                <>
                  <p className="st-eyebrow">Step 1 · Order</p>
                  <h1>Who is this for?</h1>
                  <div className="st-group">
                    <label className="nc-field"><span>Patient</span><input value={order.patient} onChange={(e) => set('patient', e.target.value)} placeholder="Name or case number" autoComplete="off" /></label>
                    <label className="nc-field"><span>Doctor</span><input value={order.doctor} onChange={(e) => set('doctor', e.target.value)} placeholder="Practice or dentist" autoComplete="off" /></label>
                    <label className="nc-field"><span>Due</span><input type="date" value={order.due} onChange={(e) => set('due', e.target.value)} /></label>
                  </div>
                  <div className="st-group">
                    <div className="st-group-head">Have the exocad order or the whole export?</div>
                    <p className="st-foot">A <b>.dentalProject</b> fills in the tooth, restoration and material. A <b>.zip</b> of the scanner export fills in the scans too.</p>
                    <div className="st-actions">
                      <button className="st-btn tinted" onClick={() => projectRef.current?.click()}>Import Order</button>
                      <button className="st-btn tinted" onClick={() => choose(null)}>Import All Files</button>
                    </div>
                  </div>
                  <p className="nc-swipe-hint">Swipe left to continue</p>
                </>
              )}

              {c.kind === 'tooth' && (
                <>
                  <p className="st-eyebrow">Step 2 · Tooth</p>
                  <h1>{order.tooth ? `#${order.tooth} · ${toothName}` : 'Which tooth?'}</h1>
                  <ArchChart selected={order.tooth} onPick={(n) => { set('tooth', n); vibrate(6) }} />
                  <p className="st-foot">Universal numbering · one crown per case. {order.tooth ? `The ${jawOf(order.tooth)} jaw will be the prep scan.` : ''}</p>
                </>
              )}

              {c.kind === 'restoration' && (
                <>
                  <p className="st-eyebrow">Step 3 · Restoration</p>
                  <h1>What are we making?</h1>
                  <div className="st-group">
                    {RESTORATIONS.map((r) => (
                      <button key={r.id} className={`nc-option ${order.restoration === r.id ? 'on' : ''}`} disabled={!r.ready} onClick={() => set('restoration', r.id)}>
                        <span>{r.label}</span>
                        <em>{r.ready ? (order.restoration === r.id ? '✓' : '') : 'Not yet'}</em>
                      </button>
                    ))}
                  </div>
                  <div className="st-group">
                    <div className="st-group-head">Material</div>
                    <div className="st-segmented wrap">
                      {(Object.keys(MATERIALS) as MaterialId[]).map((m) => (
                        <button key={m} className={order.material === m ? 'on' : ''} onClick={() => set('material', m)}>{MATERIAL_SHORT[m]}</button>
                      ))}
                    </div>
                    <p className="st-foot">{MATERIALS[order.material].label}: min {MATERIALS[order.material].minAxialMm} mm axial, {MATERIALS[order.material].minOcclusalMm} mm occlusal.</p>
                  </div>
                  <div className="st-group">
                    <div className="st-group-head">Shade</div>
                    <div className="nc-chips">
                      {SHADES.map((s) => (
                        <button key={s} className={order.shade === s ? 'on' : ''} onClick={() => set('shade', s)}>{s}</button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {c.kind === 'scans' && (
                <>
                  <p className="st-eyebrow">Step 4 · Scans</p>
                  <h1>Which scans does this case have?</h1>
                  <div className="st-group">
                    <Toggle label="Opposing jaw scan" sub="Needed for contacts with the bite. Strongly recommended." on={order.antagonist} set={(v) => set('antagonist', v)} />
                    <Toggle label="Pre-op scan" sub="The tooth before preparation." on={order.preop} set={(v) => set('preop', v)} />
                    <Toggle label="Bite scan" sub="Only when the arches were exported separately." on={order.bite} set={(v) => set('bite', v)} />
                  </div>
                  <div className="st-group">
                    <div className="st-group-head">You'll be asked for, in order</div>
                    {slots.map((s, k) => (
                      <div key={s.id} className="nc-plan">
                        <span className="nc-num">{k + 1}</span>
                        <span><b>{s.title}</b>{s.required ? '' : ' · optional'}</span>
                        <em>{scans[s.id] ? '✓' : ''}</em>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {c.kind === 'scan' && (
                <ScanCard slot={c.slot} n={c.n} of={c.of} tooth={order.tooth} scan={scans[c.slot.id]} onChoose={() => choose(c.slot.id)} onRemove={() => setScans((s) => ({ ...s, [c.slot.id]: undefined }))} />
              )}

              {c.kind === 'review' && (
                <>
                  <p className="st-eyebrow">Ready</p>
                  <h1>{order.patient || 'New case'}{order.tooth ? ` · #${order.tooth}` : ''}</h1>
                  <div className="st-group">
                    <Row k="Tooth" v={order.tooth ? `#${order.tooth} ${toothName}` : '—'} ok={order.tooth !== null} onClick={() => setIndex(1)} />
                    <Row k="Restoration" v={`${RESTORATIONS.find((r) => r.id === order.restoration)!.label}, ${MATERIAL_SHORT[order.material]}, ${order.shade}`} ok onClick={() => setIndex(2)} />
                    {order.doctor && <Row k="Doctor" v={order.doctor} ok onClick={() => setIndex(0)} />}
                    {order.due && <Row k="Due" v={order.due} ok onClick={() => setIndex(0)} />}
                  </div>
                  <div className="st-group">
                    <div className="st-group-head">Scans</div>
                    {slots.map((s) => (
                      <Row key={s.id} k={s.title} v={scans[s.id]?.name ?? (s.required ? 'Missing' : 'Skipped')} ok={!!scans[s.id] || !s.required} warn={!!scans[s.id]?.check.warnings.length} onClick={() => setIndex(cards.findIndex((x) => x.kind === 'scan' && x.slot.id === s.id))} />
                    ))}
                    {bite && <p className="nc-warn">{bite}</p>}
                  </div>
                  <p className="st-foot">Next: the scans open in the designer — tap the prepared tooth and the crown is designed and checked.</p>
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

      <input ref={fileRef} type="file" accept=".stl,.ply,.zip,.dentalProject" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void onFiles(f) }} />
      <input ref={projectRef} type="file" accept=".dentalProject,.xml,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onProject(f) }} />
    </div>
  )
}

function ScanCard(props: { slot: ScanSlot; n: number; of: number; tooth: number | null; scan?: LoadedScan; onChoose: () => void; onRemove: () => void }): React.JSX.Element {
  const { slot, scan } = props
  return (
    <>
      <p className="st-eyebrow">Scan {props.n} of {props.of}{slot.required ? '' : ' · optional'}</p>
      <h1>{slot.title}</h1>
      <ArchChart selected={props.tooth} highlight={slot.id === 'bite' ? 'both' : slot.jaw} dashed={slot.id === 'preop'} compact />
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
            {!slot.required && <button className="st-btn tinted" onClick={props.onRemove}>Remove</button>}
          </div>
        </div>
      ) : (
        <button className="nc-drop" onClick={props.onChoose}>
          <span>＋</span>
          Tap to choose the file
          <small>STL · PLY · or the whole export as .zip</small>
        </button>
      )}
    </>
  )
}

function Toggle(props: { label: string; sub: string; on: boolean; set: (v: boolean) => void }): React.JSX.Element {
  return (
    <div className="nc-toggle">
      <span><b>{props.label}</b><small>{props.sub}</small></span>
      <label className="st-switch">
        <input type="checkbox" role="switch" checked={props.on} aria-label={props.label} onChange={(e) => props.set(e.target.checked)} />
        <span />
      </label>
    </div>
  )
}

function Row(props: { k: string; v: string; ok: boolean; warn?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button className="nc-row" onClick={props.onClick}>
      <span className={`nc-dot ${!props.ok ? 'missing' : props.warn ? 'warn' : 'ok'}`} />
      <span className="nc-row-k">{props.k}</span>
      <span className="nc-row-v">{props.v}</span>
      <span className="nc-chev">›</span>
    </button>
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
