/**
 * Why automatic prep finding misses (dev): per lab case, findPrep's candidates
 * against the technician's margin, and the margin each search direction finds.
 *   npx vite-node scripts/dbg-find.ts -- dev/cases/lm
 */
import { parseScan } from '../src/core/meshConvert'
import { bestMargin, findPrep, stumpTop } from '../src/crown/findPrep'
import { SurfaceIndex, type Vec3 } from '../src/crown/geom'
import { fdiToUniversal } from '../src/crown/library'
import { detectMargin, marginError, plausibleLoop } from '../src/crown/margin'
import { listCases, loadLabCase } from './lib/labCases'

const root = process.argv.slice(2).filter((a) => a !== '--' && !a.startsWith('--'))[0] ?? 'dev/cases/lm'
const d = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
for (const id of listCases(root)) {
  const c = loadLabCase(root, id)
  if (!c.antagonist) continue
  const prep = new SurfaceIndex(c.prepGeometry)
  const ant = new SurfaceIndex(parseScan(c.antagonist.name, c.antagonist.data))
  const mc = c.margin.reduce((s, p) => [s[0] + p[0] / c.margin.length, s[1] + p[1] / c.margin.length, s[2] + p[2] / c.margin.length] as Vec3, [0, 0, 0] as Vec3)
  const g = findPrep(prep, ant, fdiToUniversal(c.fdi))
  const cands = (g.candidates ?? []).map((x) => `${d(x.point, mc).toFixed(1)}mm/${x.areaMm2.toFixed(0)}mm²/${x.offDeg?.toFixed(0)}°`).join(' ')
  console.log(`${id} #${c.fdi}: point ${g.point ? d(g.point, mc).toFixed(1) + ' mm from tech' : 'none (' + g.reason + ')'} · blobs ${g.blobsMm2.slice(0, 4).map((a) => a.toFixed(0)).join(',')} · cands ${cands}`)
  if (!g.point || process.argv.includes('--find-only')) continue
  const tries = [{ name: 'own', m: detectMargin(prep, g.point) }, ...(g.ups ?? []).map((up, k) => ({ name: `up${k}`, m: detectMargin(prep, stumpTop(prep, g.point!, up), { up }) }))]
  for (const t of tries) {
    const conf = t.m.points.length ? t.m.confidence.reduce((a, b) => a + b, 0) / t.m.confidence.length : 0
    const e = t.m.points.length >= 16 ? marginError(t.m.points, c.margin) : null
    console.log(`   ${t.name}: n=${t.m.points.length} conf ${conf.toFixed(2)} miss ${t.m.missingFraction.toFixed(2)} plaus ${plausibleLoop(t.m)} err ${e ? e.mean.toFixed(2) : '—'}`)
  }
  const b = bestMargin(prep, g.point, g.ups ?? [])
  console.log(`   best err ${b.points.length >= 16 ? marginError(b.points, c.margin).mean.toFixed(2) : '—'}`)
}
