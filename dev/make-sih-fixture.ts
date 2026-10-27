// Dev: writes the synthetic #19 case as a .sih (for the New Case e2e).
//   npx vite-node dev/make-sih-fixture.ts <out.sih>
import { writeFileSync } from 'node:fs'
import { writeSih } from '../src/core/sih'
import { syntheticMolarCase } from '../src/crown/synthetic'

const c = syntheticMolarCase()
const bytes = await writeSih({
  case: { id: 'synthetic-19', tooth: 36, system: 'fdi', material: 'Zirconia' }, // FDI 36 = Universal #19
  scans: [
    { role: 'prep', jaw: 'lower', geometry: c.prep },
    { role: 'antagonist', jaw: 'upper', geometry: c.antagonist }
  ]
})
writeFileSync(process.argv[2] ?? 'synthetic-19.sih', bytes)
