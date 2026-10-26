import { useMemo, useRef, useState } from 'react'
import type { DesignData } from '../crown/protocol'

/**
 * The AI result as review cards: only what needs the technician comes to the
 * front — one card per check that warns or fails — and everything else is
 * counted as passed. Swipe right (or tap Accept) to accept a warning; swipe
 * left (or Adjust) to open the stage that fixes it. A failing check can't be
 * accepted. When nothing is left, the last card approves the crown.
 */

export type AdjustTarget = 'margin' | 'axis' | 'anatomy' | 'design'

const TARGET: Record<string, AdjustTarget> = {
  margin: 'margin',
  undercut: 'axis',
  orientation: 'axis',
  'thickness-axial': 'design',
  'thickness-occlusal': 'design',
  'contact-mesial': 'design',
  'contact-distal': 'design',
  occlusion: 'design',
  watertight: 'design',
  'self-intersection': 'design'
}

interface Card {
  id: string
  verdict: 'warn' | 'fail'
  title: string
  measured: string
  required: string
  body: string
  fix?: string
}

export default function ReviewDeck(props: {
  design: DesignData
  anatomy: { library: boolean; label: string }
  library: 'round' | 'rectangular'
  setLibrary: (l: 'round' | 'rectangular') => void
  ai: boolean
  embedded: boolean
  onAdjust: (target: AdjustTarget) => void
  onFixWithAi: () => void
  onApprove: () => void
  onSendBack?: () => void
}): React.JSX.Element {
  const d = props.design
  const cards: Card[] = useMemo(() => {
    // The requirement tile shows the number; the material is named on the nav bar.
    const short = (x: string): string => x.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '')
    const out: Card[] = d.results
      .filter((r) => r.verdict !== 'pass')
      .sort((a, b) => (a.verdict === 'fail' ? -1 : 0) - (b.verdict === 'fail' ? -1 : 0))
      .map((r) => ({ id: r.id, verdict: r.verdict as 'warn' | 'fail', title: r.label, measured: r.measured, required: short(r.required), body: r.message, fix: r.fix }))
    if (!props.anatomy.library)
      out.push({ id: 'anatomy', verdict: 'warn', title: 'Textbook anatomy', measured: 'no library tooth', required: 'library tooth', body: 'There is no library tooth for this position, so the shape comes from the textbook template. Contacts, occlusion and thickness are still checked.' })
    return out
  }, [d, props.anatomy.library])
  const [accepted, setAccepted] = useState<string[]>([])
  // A new design brings new cards: forget acceptances of checks that changed.
  const key = cards.map((c) => `${c.id}:${c.measured}`).join('|')
  const lastKey = useRef(key)
  if (lastKey.current !== key) {
    lastKey.current = key
    if (accepted.length) setAccepted([])
  }
  const open = cards.filter((c) => !accepted.includes(c.id))
  const card = open[0]
  const passed = d.results.filter((r) => r.verdict === 'pass').length
  const total = d.results.length

  /* swipe */
  const [dx, setDx] = useState(0)
  const g = useRef<{ x: number; y: number; id: number; on: boolean } | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const accept = (): void => {
    if (card && card.verdict === 'warn') setAccepted((a) => [...a, card.id])
  }
  const adjust = (): void => {
    if (card) props.onAdjust(TARGET[card.id] ?? (card.id === 'anatomy' ? 'anatomy' : 'design'))
  }
  const handlers = {
    onPointerDown: (e: React.PointerEvent): void => {
      if ((e.target as Element).closest('button')) return
      g.current = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false }
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const s = g.current
      if (!s || s.id !== e.pointerId) return
      const mx = e.clientX - s.x
      if (!s.on) {
        if (Math.abs(e.clientY - s.y) > 12 && Math.abs(e.clientY - s.y) > Math.abs(mx)) return void (g.current = null)
        if (Math.abs(mx) < 10) return
        s.on = true
        el.current?.setPointerCapture(e.pointerId)
      }
      // A failing check resists a right swipe: it can't be accepted.
      setDx(mx > 0 && card?.verdict === 'fail' ? mx * 0.2 : mx)
    },
    onPointerUp: (e: React.PointerEvent): void => {
      const s = g.current
      g.current = null
      if (!s?.on) return
      const mx = e.clientX - s.x
      const w = el.current?.clientWidth ?? 340
      setDx(0)
      if (mx > w * 0.3) accept()
      else if (mx < -w * 0.3) adjust()
    },
    onPointerCancel: (): void => {
      g.current = null
      setDx(0)
    }
  }

  const tilt = { transform: `translateX(${dx}px) rotate(${dx / 40}deg)`, transition: dx ? 'none' : 'transform 0.25s ease' }
  const stamp = dx > 40 ? 'accept' : dx < -40 ? 'adjust' : null

  return (
    <div className="rv">
      <div className="rv-head">
        {open.length ? (
          <span>
            <b className={open.some((c) => c.verdict === 'fail') ? 'bad' : 'warn'}>{open.length} to review</b> · {passed} of {total} checks passed on their own
          </span>
        ) : (
          <span>
            <b className="good">All clear</b> · {passed} of {total} checks pass{accepted.length ? `, ${accepted.length} accepted by you` : ''}
          </span>
        )}
        <div className="rv-bar" aria-hidden>
          {d.results.map((r) => (
            <i key={r.id} className={r.verdict === 'pass' || accepted.includes(r.id) ? 'good' : r.verdict} />
          ))}
        </div>
      </div>

      {card ? (
        <div className="rv-stack">
          {open.length > 1 && <div className="rv-under" aria-hidden />}
          <article ref={el} className={`rv-card ${card.verdict}`} style={tilt} {...handlers} aria-live="polite">
            {stamp && <span className={`rv-stamp ${stamp}`}>{stamp === 'accept' ? 'Accept' : 'Adjust'}</span>}
            <span className={`rv-tag ${card.verdict}`}>{card.verdict === 'fail' ? 'Must fix' : 'Check this'}</span>
            <h2>{card.title}</h2>
            <div className="rv-measure">
              <span>
                <b>{card.measured}</b>measured
              </span>
              <span>
                <b>{card.required}</b>required
              </span>
            </div>
            <p>{card.body}</p>
            {card.fix && <p className="rv-fix">{card.fix}</p>}
            <div className="rv-actions">
              <button className="rv-btn ghost" onClick={adjust}>Adjust</button>
              {card.verdict === 'warn' ? (
                <button className="rv-btn solid" onClick={accept}>Accept</button>
              ) : props.ai ? (
                <button className="rv-btn solid" onClick={props.onFixWithAi}>Fix with AI</button>
              ) : (
                <button className="rv-btn solid" onClick={adjust}>Fix it</button>
              )}
            </div>
          </article>
          <p className="rv-hint">{card.verdict === 'warn' ? 'Swipe right to accept · left to adjust' : 'Swipe left to adjust — a failing check must be fixed'}</p>
        </div>
      ) : (
        <article className="rv-card done">
          <span className="rv-tag good">Ready to mill</span>
          <h2>Approve this crown</h2>
          <div className="rv-stats">
            <span>
              <b>{fmt(d.summary.mesialContactMm)} / {fmt(d.summary.distalContactMm)}</b>contacts M / D mm
            </span>
            <span>
              <b>{fmt(d.summary.occlusalMinMm)}</b>occlusal clearance mm
            </span>
            <span>
              <b>{fmt(d.summary.minAxialThicknessMm)} / {fmt(d.summary.minOcclusalThicknessMm)}</b>thinnest wall axial / occl mm
            </span>
            <span>
              <b>{fmt(d.volumeMm3, 0)}</b>volume mm³
            </span>
          </div>
          <div className="rv-anatomy">
            <span>Anatomy</span>
            <div className="rv-seg" role="group" aria-label="Library shape">
              <button className={props.library === 'round' ? 'on' : ''} onClick={() => props.setLibrary('round')}>Round</button>
              <button className={props.library === 'rectangular' ? 'on' : ''} onClick={() => props.setLibrary('rectangular')}>Rectangular</button>
            </div>
          </div>
          <button className="rv-btn solid big" onClick={props.onApprove}>
            {props.embedded ? 'Approve & Send' : 'Approve & Export'}
          </button>
          <div className="rv-actions">
            <button className="rv-btn ghost" onClick={() => props.onAdjust('design')}>Adjust Design</button>
            {props.onSendBack && <button className="rv-btn ghost" onClick={props.onSendBack}>Send Back</button>}
          </div>
        </article>
      )}
    </div>
  )
}

const fmt = (x: number | null | undefined, digits = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits))
