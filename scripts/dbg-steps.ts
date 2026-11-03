// Dev: the outer-design step log for one lab case (own crown as donor).
import { parseScan } from '../src/core/meshConvert'
import { donorTemplate } from '../src/crown/donors'
import { fdiToUniversal } from '../src/crown/library'
import { marginFromTaps } from '../src/crown/margin'
import { autoDesign, prepareCase } from '../src/crown/pipeline'
import { trainShapeModel } from '../src/crown/ssm'
import { analyseCase } from '../src/crown/train'
import { loadLabCase } from './lib/labCases'
const [root, id] = process.argv.slice(2).filter((a) => a !== '--')
const c = loadLabCase(root, id)
const tooth = fdiToUniversal(c.fdi)!
const a = analyseCase({ id, toothNumber: tooth, prep: c.prepGeometry, crown: c.crown, margin: c.margin })
const pc = prepareCase({ toothNumber: tooth, prep: c.prepGeometry, antagonist: c.antagonist ? parseScan(c.antagonist.name, c.antagonist.data) : null })
const r = autoDesign(pc, { margin: marginFromTaps(pc.prepIndex, c.margin), params: { occlusalContacts: false }, template: donorTemplate({ id, model: trainShapeModel(a.cls, [a.shape!]), size: a.size }) })
console.log(r.outer.measures.steps.join('\n'))
console.log('space mesial', r.outer.measures.spaceMesialMm, 'distal', r.outer.measures.spaceDistalMm, 'size', a.size)
