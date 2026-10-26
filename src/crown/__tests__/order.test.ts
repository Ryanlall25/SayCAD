import { describe, expect, it } from 'vitest'
import { assignToSlots, checkScan, NEW_ORDER, occlusionWarning, orderFromProject, parseDentalProject, scanSlots, slotForName, type ScanStats } from '../order'

const stats = (size: [number, number, number], at: [number, number, number] = [0, 0, 0], triangles = 300000): ScanStats => ({
  triangles,
  size,
  min: at,
  max: [at[0] + size[0], at[1] + size[1], at[2] + size[2]]
})

describe('case order → scans', () => {
  it('asks for nothing until a tooth is picked', () => {
    expect(scanSlots(NEW_ORDER)).toEqual([])
  })

  it('lower molar: lower jaw is the prep, upper the opposing, in that order', () => {
    const s = scanSlots({ ...NEW_ORDER, tooth: 19 })
    expect(s.map((x) => [x.id, x.jaw])).toEqual([['prep', 'lower'], ['antagonist', 'upper']])
    expect(s[0].ask).toContain('LOWER jaw')
    expect(s[0].ask).toContain('#19')
  })

  it('upper tooth flips the jaws; extras are optional and flagged as unused', () => {
    const s = scanSlots({ ...NEW_ORDER, tooth: 3, preop: true, bite: true })
    expect(s.map((x) => x.id)).toEqual(['prep', 'antagonist', 'bite', 'preop'])
    expect(s[0].jaw).toBe('upper')
    expect(s.filter((x) => !x.required).every((x) => !x.used)).toBe(true)
  })

  it('no opposing scan when the order says so', () => {
    expect(scanSlots({ ...NEW_ORDER, tooth: 30, antagonist: false }).map((x) => x.id)).toEqual(['prep'])
  })
})

describe('placing files', () => {
  const slots = scanSlots({ ...NEW_ORDER, tooth: 19, bite: true })
  it('reads jaws from common export names', () => {
    expect(slotForName('2024-04-12_Smith-lowerjaw.stl', slots)).toBe('prep')
    expect(slotForName('Smith_UpperJaw.ply', slots)).toBe('antagonist')
    expect(slotForName('scan-mandibular.stl', slots)).toBe('prep')
    expect(slotForName('scan-maxillary.stl', slots)).toBe('antagonist')
    expect(slotForName('case_u.stl', slots)).toBe('antagonist')
    expect(slotForName('BuccalBite.stl', slots)).toBe('bite')
    expect(slotForName('crown_19.stl', slots)).toBeNull()
    expect(slotForName('notes.txt', slots)).toBeNull()
  })

  it('a whole export at once fills every slot; unclear names fill required slots', () => {
    expect(assignToSlots(['a-lowerjaw.stl', 'a-upperjaw.stl', 'a-bite.stl', 'readme.pdf'], slots)).toEqual({ prep: 'a-lowerjaw.stl', antagonist: 'a-upperjaw.stl', bite: 'a-bite.stl' })
    expect(assignToSlots(['scan1.stl', 'scan2.stl'], slots)).toEqual({ prep: 'scan1.stl', antagonist: 'scan2.stl' })
    expect(assignToSlots(['scan2.stl'], slots, { prep: {} })).toEqual({ antagonist: 'scan2.stl' })
  })
})

describe('scan checks', () => {
  const [prep, ant] = scanSlots({ ...NEW_ORDER, tooth: 19 })
  it('describes a good full arch without warnings', () => {
    const c = checkScan('x-lowerjaw.stl', stats([58, 50, 20]), prep)
    expect(c.summary).toMatch(/^Full arch · 58 × 50 × 20 mm · 300k triangles/)
    expect(c.warnings).toEqual([])
  })
  it('catches the wrong jaw, metres, dies and crowns', () => {
    expect(checkScan('x-upperjaw.stl', stats([58, 50, 20]), prep).warnings.join()).toContain('needs the LOWER jaw')
    expect(checkScan('x.stl', stats([0.05, 0.04, 0.02]), prep).warnings.join()).toContain('metres')
    expect(checkScan('die.stl', stats([10, 9, 8]), prep).warnings.join()).toContain('neighbouring teeth')
    expect(checkScan('crown_19.stl', stats([11, 10, 8]), ant).warnings.join()).toContain('designed crown')
  })
  it('flags arches that are not in occlusion', () => {
    expect(occlusionWarning(stats([58, 50, 20]), stats([58, 50, 20], [0, 0, 20.5]))).toBeNull()
    expect(occlusionWarning(stats([58, 50, 20]), stats([58, 50, 20], [80, 0, 0]))).toContain('22 mm apart')
  })
})

describe('exocad .dentalProject', () => {
  const xml = (teeth: string): string => `<?xml version="1.0"?><Treatment><Teeth>${teeth}</Teeth></Treatment>`
  const tooth = (n: number, type: string, mat: string): string => `<Tooth><Number>${n}</Number><ReconstructionType>${type}</ReconstructionType><Parameters /><MaterialName>${mat}</MaterialName></Tooth>`

  it('fills the order from the first restoration (FDI → Universal)', () => {
    const t = parseDentalProject(xml(tooth(35, 'LibraryTooth', 'Healthy tooth') + tooth(36, 'Anatomic', 'Zirconia HT') + tooth(26, 'Antagonist', 'Antagonist')))
    expect(t.map((x) => x.role)).toEqual(['neighbour', 'restoration', 'antagonist'])
    const { order, note } = orderFromProject(t, NEW_ORDER)
    expect(order.tooth).toBe(19)
    expect(order.material).toBe('zirconia-ht')
    expect(order.restoration).toBe('crown')
    expect(note).toContain('FDI 36')
  })

  it('reads exocad\'s own layout (CRLF, indentation, empty Parameters): all healthy → no restoration', () => {
    const text = '<?xml version="1.0" encoding="utf-8"?>\r\n<Treatment xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\r\n   <Teeth>\r\n' +
      [31, 32, 36, 48].map((n) => `    <Tooth>\r\n      <Number>${n}</Number>\r\n      <ReconstructionType>LibraryTooth</ReconstructionType>\r\n      <Parameters />\r\n      <MaterialName>Healthy tooth</MaterialName>\r\n      <Material>HT</Material>\r\n    </Tooth>\r\n`).join('') +
      '  </Teeth>\r\n</Treatment>'
    const t = parseDentalProject(text)
    expect(t.map((x) => x.universal)).toEqual([24, 23, 19, 32])
    expect(t.every((x) => x.role === 'neighbour')).toBe(true)
    expect(orderFromProject(t, NEW_ORDER).order.tooth).toBeNull()
  })
})
