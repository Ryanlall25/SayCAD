import { describe, expect, it } from 'vitest'
import { parseCrown } from './crownParser'

describe('crown grammar', () => {
  const cases: Array<[string, unknown]> = [
    ['tooth 19', { kind: 'setTooth', tooth: 19 }],
    ['design tooth number thirty', { kind: 'setTooth', tooth: 30 }],
    ['auto design', { kind: 'autoDesign' }],
    ['design it', { kind: 'autoDesign' }],
    ['tighter mesial contact', { kind: 'param', param: 'contactMesialMm', mode: 'change', value: -0.02 }],
    ['open the distal contact 0.05', { kind: 'param', param: 'contactDistalMm', mode: 'change', value: 0.05 }],
    ['make the distal contact a bit lighter', { kind: 'param', param: 'contactDistalMm', mode: 'change', value: 0.02 }],
    ["it's high", { kind: 'param', param: 'occlusalClearanceMm', mode: 'change', value: 0.05 }],
    ['occlusal clearance 0.1', { kind: 'param', param: 'occlusalClearanceMm', mode: 'set', value: 0.1 }],
    ['add 0.2 to the mesiobuccal cusp', { kind: 'sculpt', region: 'mesiobuccal', amountMm: 0.2, radiusMm: 1.5 }],
    ['reduce the DL cusp point three', { kind: 'sculpt', region: 'distolingual', amountMm: -0.3, radiusMm: 1.5 }],
    ['raise the mesial marginal ridge', { kind: 'sculpt', region: 'mesial-marginal-ridge', amountMm: 0.15, radiusMm: 1.5 }],
    ['flatter cusps', { kind: 'param', param: 'cuspScale', mode: 'change', value: -0.1 }],
    ['more pronounced cusps', { kind: 'param', param: 'cuspScale', mode: 'change', value: 0.1 }],
    ['deeper grooves', { kind: 'param', param: 'grooveScale', mode: 'change', value: 0.25 }],
    ['fuller buccal', { kind: 'param', param: 'buccalBulgeMm', mode: 'change', value: 0.15 }],
    ['lower the crown 0.1', { kind: 'param', param: 'heightOffsetMm', mode: 'change', value: -0.1 }],
    ['rotate 5 degrees', { kind: 'param', param: 'rotationDeg', mode: 'change', value: 5 }],
    ['shift it mesially 0.2', { kind: 'param', param: 'mdShiftMm', mode: 'change', value: 0.2 }],
    ['make it emax', { kind: 'material', material: 'lithium-disilicate' }],
    ['zirconia', { kind: 'material', material: 'zirconia-hs' }],
    ['switch to high translucency zirconia', { kind: 'material', material: 'zirconia-ht' }],
    ['cement gap 60 microns', { kind: 'param', param: 'cementGapMm', mode: 'set', value: 0.06 }],
    ['flip buccal', { kind: 'flipBuccal' }],
    ['show occlusal', { kind: 'view', view: 'occlusal' }],
    ['hide antagonist', { kind: 'layer', layer: 'antagonist', visible: false }],
    ['show thickness', { kind: 'layer', layer: 'heatmap', visible: true }],
    ['check', { kind: 'check' }],
    ['export stl', { kind: 'export' }],
    ['review', { kind: 'review' }],
    ['load the demo case', { kind: 'demo' }],
    ['undo', { kind: 'undo' }]
  ]
  for (const [say, expected] of cases) {
    it(`“${say}”`, () => {
      const got = parseCrown(say)
      if ('value' in (expected as object) && 'value' in got) {
        expect({ ...got, value: Number((got as { value: number }).value.toFixed(4)) }).toEqual(expected)
      } else expect(got).toEqual(expected)
    })
  }
  it('passes anything else through as unknown (for the AI layer)', () => {
    expect(parseCrown('make it look more like the neighbour').kind).toBe('unknown')
  })
})
