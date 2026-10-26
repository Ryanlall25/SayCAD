import * as THREE from 'three'
import { toothClassOf } from './anatomy'
import { editMargin } from './margin'
import { detectMargin } from './margin'
import { autoDesign, prepareCase, type PreparedCase } from './pipeline'
import type { DesignData, EngineRequest, MeshData } from './protocol'
import { parseShapeModel, templateFromModel, type ShapeModel } from './ssm'
import { analyseLibrary, libraryModels, libraryToothNumber } from './library'
import { findPrep } from './findPrep'
import { SurfaceIndex } from './geom'

/**
 * Engine request handler — runs inside the worker (or in-thread as a
 * fallback). Pure dispatch over the pipeline; owns the prepared case.
 */

let prepared: PreparedCase | null = null
let modelCache: { json: string; model: ShapeModel } | null = null

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
  if (m.indices) g.setIndex(new THREE.BufferAttribute(m.indices, 1))
  return g
}

export function handleEngineRequest(req: EngineRequest): { result: unknown; transfer: Transferable[] } {
  switch (req.type) {
    case 'load': {
      prepared = prepareCase({ toothNumber: req.toothNumber, prep: toGeometry(req.prep), antagonist: req.antagonist ? toGeometry(req.antagonist) : null })
      return { result: { triangles: prepared.prepIndex.triangleCount }, transfer: [] }
    }
    case 'setTooth': {
      if (prepared) prepared = { ...prepared, toothNumber: req.toothNumber }
      return { result: true, transfer: [] }
    }
    case 'margin': {
      if (!prepared) throw new Error('Load the scans first.')
      const m = detectMargin(prepared.prepIndex, req.tap)
      if (m.points.length < 16) throw new Error('No margin found there — tap the top of the prepared tooth.')
      return { result: m, transfer: [] }
    }
    case 'findPrep': {
      if (!prepared) throw new Error('Load the scans first.')
      return { result: findPrep(prepared.prepIndex, prepared.antagonist ? new SurfaceIndex(prepared.antagonist.clone()) : null), transfer: [] }
    }
    case 'editMargin': {
      if (!prepared) throw new Error('Load the scans first.')
      return { result: editMargin(req.points, req.tapped, prepared.prepIndex), transfer: [] }
    }
    case 'importLibrary': {
      const names = req.files.map((f) => f.name)
      const teeth = req.files.flatMap((f) => {
        const n = libraryToothNumber(f.name, req.numbering, names, req.jaw)
        return n ? [{ name: f.name, toothNumber: n, geometry: toGeometry(f.mesh) }] : []
      })
      const imported = analyseLibrary(teeth)
      const models = libraryModels(imported, req.source)
      return {
        result: {
          teeth: imported.map((t) => ({ name: t.name, tooth: t.toothNumber, cls: t.cls, ok: Boolean(t.shape), error: t.error })),
          skipped: names.filter((n) => !teeth.some((t) => t.name === n)),
          models: Object.fromEntries(Object.entries(models).map(([cls, m]) => [cls, JSON.stringify(m)]))
        },
        transfer: []
      }
    }
    case 'design': {
      if (!prepared) throw new Error('Load the scans first.')
      let template
      if (req.model) {
        if (modelCache?.json !== req.model) {
          const model = parseShapeModel(req.model)
          modelCache = model ? { json: req.model, model } : null
        }
        if (modelCache && modelCache.model.cls === toothClassOf(prepared.toothNumber)) {
          template = templateFromModel(modelCache.model)
        }
      }
      const preview = req.quality === 'preview'
      const r = autoDesign(prepared, {
        margin: req.margin,
        params: req.params,
        flipBuccal: req.flipBuccal,
        nu: template ? undefined : preview ? 96 : 128,
        nv: template ? undefined : preview ? 42 : 56,
        template
      })
      const positions = (r.crown.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
      const indices = (r.crown.index as THREE.BufferAttribute).array as Uint32Array
      const nu = r.outer.grid.nu
      const nv = r.outer.grid.nv
      const thickness = new Float32Array(positions.length / 3).fill(NaN)
      for (let k = 0; k < nu * nv; k++) thickness[k] = r.report.thickness[k]
      const data: DesignData = {
        crown: { positions, indices },
        thickness,
        nu,
        nv,
        frame: r.frame,
        buccalConfidence: r.buccalConfidence,
        margin: r.margin,
        results: r.report.results,
        exportable: r.report.exportable,
        summary: r.report.summary,
        measures: r.outer.measures,
        cuspTips: r.outer.cuspTips,
        params: r.params,
        timingsMs: r.timingsMs,
        volumeMm3: r.watertight.volumeMm3
      }
      return { result: data, transfer: [positions.buffer, indices.buffer, thickness.buffer] }
    }
  }
}
