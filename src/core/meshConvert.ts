import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js'

/**
 * Renderer-only STL/PLY parsing + conversion, built on three.js's own loader/
 * exporter addons (three/examples/jsm/*) rather than a separate parsing lib —
 * one geometry representation (THREE.BufferGeometry) serves both the 3D
 * viewer and the format converter. No backend involved; everything here runs
 * on whichever machine has the browser tab open (desktop app or phone).
 */

export type MeshFormat = 'stl' | 'ply' | 'obj'

export const MAX_RECOMMENDED_SIZE = 50 * 1024 * 1024 // 50MB

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatOf(fileName: string): MeshFormat {
  const n = fileName.toLowerCase()
  return n.endsWith('.ply') ? 'ply' : n.endsWith('.obj') ? 'obj' : 'stl'
}

/**
 * Wavefront OBJ as dental CAD exports it: `v x y z [r g b]` with optional
 * per-vertex colour (0–1 or 0–255), and polygon faces (`f a/b/c …`,
 * fanned into triangles). Texture coordinates and normals are ignored;
 * colour is kept as a `color` attribute so the viewer shows the scan's
 * real tooth and gum shades.
 */
export function parseObj(buffer: ArrayBuffer): THREE.BufferGeometry {
  const text = new TextDecoder().decode(buffer)
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  let hasColour = true
  let maxColour = 0
  let start = 0
  const n = text.length
  while (start < n) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = n
    const c0 = text.charCodeAt(start)
    if (c0 === 118 /* v */ && text.charCodeAt(start + 1) === 32) {
      const f = text.slice(start + 2, end).trim().split(/\s+/)
      pos.push(+f[0], +f[1], +f[2])
      if (f.length >= 6) {
        const r = +f[3], g = +f[4], b = +f[5]
        col.push(r, g, b)
        maxColour = Math.max(maxColour, r, g, b)
      } else hasColour = false
    } else if (c0 === 102 /* f */ && text.charCodeAt(start + 1) === 32) {
      const f = text.slice(start + 2, end).trim().split(/\s+/)
      const vs = f.map((t) => {
        const k = parseInt(t, 10)
        return k < 0 ? pos.length / 3 + k : k - 1
      })
      for (let k = 1; k + 1 < vs.length; k++) idx.push(vs[0], vs[k], vs[k + 1])
    }
    start = end + 1
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3))
  if (hasColour && col.length === pos.length) {
    const scale = maxColour > 1.001 ? 1 / 255 : 1
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(col, (x) => x * scale), 3))
  }
  if (idx.length) g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
  return g
}

/** Any scan file the lab sends (STL, PLY, OBJ) → geometry, colour kept when present. */
export function parseScan(fileName: string, buffer: ArrayBuffer): THREE.BufferGeometry {
  const format = formatOf(fileName)
  return format === 'ply' ? new PLYLoader().parse(buffer) : format === 'obj' ? parseObj(buffer) : new STLLoader().parse(buffer)
}

export function triangleCount(geometry: THREE.BufferGeometry): number {
  const count = geometry.index ? geometry.index.count : geometry.attributes.position.count
  return Math.round(count / 3)
}

/** Parses an uploaded STL, PLY or OBJ File into a ready-to-render/-export geometry. */
export async function parseGeometry(file: File): Promise<THREE.BufferGeometry> {
  const format = formatOf(file.name)
  const buffer = await file.arrayBuffer()

  let geometry: THREE.BufferGeometry
  try {
    geometry = parseScan(file.name, buffer)
  } catch {
    throw new Error(`This doesn't look like a valid ${format.toUpperCase()} file.`)
  }

  if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
    throw new Error(
      `This doesn't look like a valid ${format.toUpperCase()} file — no geometry found.`
    )
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** Binary STL — compact, and the variant most real-world dental scan tooling produces. */
export function exportSTL(geometry: THREE.BufferGeometry): Blob {
  const mesh = new THREE.Mesh(geometry)
  const dataView = new STLExporter().parse(mesh, { binary: true })
  return new Blob([dataView], { type: 'model/stl' })
}

/**
 * ASCII PLY — human-readable/debuggable, and avoids any binary
 * endianness ambiguity for a first cut of this tool.
 */
export function exportPLY(geometry: THREE.BufferGeometry): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mesh = new THREE.Mesh(geometry)
    try {
      new PLYExporter().parse(
        mesh,
        (result) => resolve(new Blob([result], { type: 'model/ply' })),
        { binary: false }
      )
    } catch (err) {
      reject(err instanceof Error ? err : new Error('PLY export failed'))
    }
  })
}
