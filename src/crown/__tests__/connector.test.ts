import { describe, expect, it } from 'vitest'
import { CONNECTOR_MIN_MM2, CONNECTOR_OVERSIZE, connectorAreaMm2, connectorVerdict } from '../connector'

// An ellipse cut to give exactly `mm2` after the facet allowance, at height:width 1.2.
const sized = (mm2: number) => {
  const raw = mm2 * CONNECTOR_OVERSIZE
  const h = Math.sqrt((4 * raw * 1.2) / Math.PI)
  return { widthMm: (4 * raw) / (Math.PI * h), heightMm: h }
}
const base = { targetMm2: 12, gumClearanceMm: 1.9, biteClearanceMm: 2.9 }

describe('connector rules', () => {
  it('reports the section the engine sized for, net of the facet allowance', () => {
    expect(connectorAreaMm2(sized(12))).toBeCloseTo(12, 6)
  })

  it('is ok at the target with room to clean and clear of the bite', () => {
    expect(connectorVerdict({ ...base, ...sized(12) }, 0.05)).toEqual({ verdict: 'ok', reasons: [] })
  })

  it('is borderline under the target or tight to the gum, and fails under the minimum', () => {
    expect(connectorVerdict({ ...base, ...sized(9) }, 0.05).verdict).toBe('borderline')
    expect(connectorVerdict({ ...base, ...sized(12), gumClearanceMm: 0.6 }, 0.05).verdict).toBe('borderline')
    const thin = connectorVerdict({ ...base, ...sized(CONNECTOR_MIN_MM2 - 1) }, 0.05)
    expect(thin.verdict).toBe('fail')
    expect(thin.reasons[0]).toMatch(/under the 6 mm² minimum/)
  })

  it('fails into the gum or into the bite, with the reason', () => {
    expect(connectorVerdict({ ...base, ...sized(12), gumClearanceMm: -0.2 }, 0.05).reasons).toContain('0.2 mm into the gum')
    expect(connectorVerdict({ ...base, ...sized(12), biteClearanceMm: -0.1 }, 0.05).verdict).toBe('fail')
  })
})
