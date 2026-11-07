import type { Segments2D } from '../crown/section'
import type { SectionSpec, SectionView } from './viewport'

/**
 * The sectional view: one slice through the tooth drawn to scale in 2D —
 * crown outline, crown intaglio, prep and opposing jaw — with the thinnest
 * wall and the bite gap in that slice marked and measured. Picks the cut
 * (off / buccolingual / mesiodistal) and slides it through the tooth.
 */
export function SectionPanel(props: {
  spec: SectionSpec | null
  view: SectionView | null
  minWallMm: number
  onChange: (spec: SectionSpec | null) => void
}) {
  const { spec, view, minWallMm, onChange } = props
  const W = 300
  const H = 210
  return (
    <div className="st-group st-section">
      <div className="st-group-head">Section</div>
      <div className="st-segmented" role="group" aria-label="Section">
        {([['off', 'Off'], ['bl', 'Buccolingual'], ['md', 'Mesiodistal']] as const).map(([k, label]) => (
          <button key={k} className={(spec?.axis ?? 'off') === k ? 'on' : ''} onClick={() => onChange(k === 'off' ? null : { axis: k, offsetMm: spec?.offsetMm ?? 0 })}>{label}</button>
        ))}
      </div>
      {spec && (
        <>
          <label className="st-slider">
            <span className="st-sl-label">
              <span>Position<i> {spec.axis === 'bl' ? '+ mesial' : '+ buccal'}</i></span>
              <b>{spec.offsetMm > 0 ? '+' : ''}{spec.offsetMm.toFixed(1)} mm</b>
            </span>
            <input type="range" min={-5} max={5} step={0.1} value={spec.offsetMm} aria-label="Section position" onChange={(e) => onChange({ ...spec, offsetMm: Number(e.target.value) })} />
          </label>
          {view && view.outer.length > 0 ? <SectionDrawing view={view} W={W} H={H} minWallMm={minWallMm} /> : <p className="st-foot">The cut misses the crown here — slide it back toward the tooth.</p>}
        </>
      )}
    </div>
  )
}

function SectionDrawing({ view, W, H, minWallMm }: { view: SectionView; W: number; H: number; minWallMm: number }) {
  // Fit the crown (plus a margin of context) into the box; y up.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let k = 0; k < view.outer.length; k += 2) {
    x0 = Math.min(x0, view.outer[k]); x1 = Math.max(x1, view.outer[k])
    y0 = Math.min(y0, view.outer[k + 1]); y1 = Math.max(y1, view.outer[k + 1])
  }
  const pad = 2.5
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad + 1
  const s = Math.min(W / (x1 - x0), H / (y1 - y0))
  const ox = (W - (x1 - x0) * s) / 2
  const oy = (H - (y1 - y0) * s) / 2
  const X = (x: number) => ox + (x - x0) * s
  const Y = (y: number) => H - oy - (y - y0) * s
  const path = (segs: Segments2D): string => {
    let d = ''
    for (let k = 0; k < segs.length; k += 4) {
      const ax = segs[k], ay = segs[k + 1], bx = segs[k + 2], by = segs[k + 3]
      // Only what falls in the box (scans run far beyond the tooth).
      if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue
      d += `M${X(ax).toFixed(1)} ${Y(ay).toFixed(1)}L${X(bx).toFixed(1)} ${Y(by).toFixed(1)}`
    }
    return d
  }
  const r = view.reading
  const thin = r.minThicknessMm
  const thinBad = thin !== null && thin < minWallMm - 0.005
  const scaleMm = 2
  return (
    <figure className="st-section-fig">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Section: thinnest wall ${thin === null ? 'not measured' : `${thin.toFixed(2)} mm`}, bite ${r.biteGapMm === null ? 'not measured' : `${r.biteGapMm.toFixed(2)} mm`}`}>
        <path d={path(view.antagonist)} className="st-sec-ant" />
        <path d={path(view.prep)} className="st-sec-prep" />
        <path d={path(view.intaglio)} className="st-sec-intaglio" />
        <path d={path(view.outer)} className="st-sec-outer" />
        {r.thinAt && <circle cx={X(r.thinAt[0])} cy={Y(r.thinAt[1])} r={5} className={thinBad ? 'st-sec-mark bad' : 'st-sec-mark'} />}
        {r.biteAt && <circle cx={X(r.biteAt[0])} cy={Y(r.biteAt[1])} r={5} className="st-sec-mark bite" />}
        <line x1={10} x2={10 + scaleMm * s} y1={H - 10} y2={H - 10} className="st-sec-scale" />
        <text x={10} y={H - 14} className="st-sec-t">{scaleMm} mm</text>
      </svg>
      <figcaption>
        <span className={thinBad ? 'bad' : ''}><i className="st-sec-key outer" /> Thinnest wall {thin === null ? '—' : `${thin.toFixed(2)} mm`}{thinBad ? ` — under ${minWallMm} mm` : ''}</span>
        <span><i className="st-sec-key bite" /> Closest to the bite {r.biteGapMm === null ? '—' : `${r.biteGapMm.toFixed(2)} mm`}</span>
        <span className="st-sec-legend"><i className="st-sec-key prep" /> prep <i className="st-sec-key intaglio" /> intaglio <i className="st-sec-key ant" /> opposing</span>
      </figcaption>
    </figure>
  )
}
