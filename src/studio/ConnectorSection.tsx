import { CONNECTOR_MIN_MM2, CONNECTOR_OVERSIZE, connectorAreaMm2, connectorVerdict, type ConnectorSection } from '../crown/connector'

/**
 * One bridge connector's cross-section, drawn to scale: the ellipse filled
 * by its verdict (green ok / amber borderline / red fail), the minimum-area
 * section dashed inside it, and the gum below and the opposing teeth above
 * at their measured distances, so the room to clean under it and the bite
 * over it read at a glance.
 */
export function ConnectorSectionView({ k, label, occlusalClearanceMm }: { k: ConnectorSection; label: string; occlusalClearanceMm: number }) {
  const { verdict, reasons } = connectorVerdict(k, occlusalClearanceMm)
  const area = connectorAreaMm2(k)
  const W = 132
  const H = 112
  const gum = k.gumClearanceMm
  const bite = k.biteClearanceMm
  // Scale: the ellipse plus whatever gum/bite room is shown (capped at 3 mm each) fits the box.
  const shownGum = gum === null ? 0 : Math.min(3, Math.max(gum, -k.heightMm / 2))
  const shownBite = bite === null ? 0 : Math.min(3, Math.max(bite, -k.heightMm / 2))
  const spanY = k.heightMm + Math.max(0, shownGum) + Math.max(0, shownBite)
  const s = Math.min((W - 16) / Math.max(k.widthMm, 1), (H - 22) / Math.max(spanY, 1))
  const cx = W / 2
  const cy = 10 + (Math.max(0, shownBite) + k.heightMm / 2) * s
  const rx = (k.widthMm / 2) * s
  const ry = (k.heightMm / 2) * s
  // The minimum section at the same proportions (as cut, with the facet allowance).
  const m = Math.sqrt((CONNECTOR_MIN_MM2 * CONNECTOR_OVERSIZE) / ((Math.PI / 4) * k.widthMm * k.heightMm))
  const fill = verdict === 'ok' ? 'var(--green)' : verdict === 'borderline' ? 'var(--amber)' : 'var(--red)'
  const word = verdict === 'ok' ? 'OK' : verdict === 'borderline' ? 'Check' : 'Fix'
  return (
    <figure className={`st-conn st-conn-${verdict}`} aria-label={`Connector ${label}: ${area.toFixed(1)} mm², ${word}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
        {bite !== null && (
          <g>
            <line x1={6} x2={W - 6} y1={cy - ry - shownBite * s} y2={cy - ry - shownBite * s} className="st-conn-bite" />
            <text x={W - 6} y={cy - ry - shownBite * s - 3} textAnchor="end" className="st-conn-t">bite {bite.toFixed(1)}</text>
          </g>
        )}
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={fill} fillOpacity={0.75} stroke={fill} strokeWidth={1.5} />
        {m < 1 && <ellipse cx={cx} cy={cy} rx={rx * m} ry={ry * m} className="st-conn-min" />}
        {gum !== null && (
          <g>
            <line x1={6} x2={W - 6} y1={cy + ry + shownGum * s} y2={cy + ry + shownGum * s} className="st-conn-gum" />
            <text x={W - 6} y={Math.min(H - 2, cy + ry + shownGum * s + 11)} textAnchor="end" className="st-conn-t">gum {gum.toFixed(1)}</text>
          </g>
        )}
      </svg>
      <figcaption>
        <b>{label}</b> · {area.toFixed(1)} mm² <span className="st-conn-word">{word}</span>
        <br />
        <span className="st-conn-dims">{k.widthMm.toFixed(1)} × {k.heightMm.toFixed(1)} mm · target {k.targetMm2} mm²</span>
        {reasons.length > 0 && <span className="st-conn-why">{reasons.join('; ')}</span>}
      </figcaption>
    </figure>
  )
}
