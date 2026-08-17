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

export type MeshFormat = 'stl' | 'ply'

export const MAX_RECOMMENDED_SIZE = 50 * 1024 * 1024 // 50MB

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatOf(fileName: string): MeshFormat {
  return fileName.toLowerCase().endsWith('.ply') ? 'ply' : 'stl'
}

export function triangleCount(geometry: THREE.BufferGeometry): number {
  const count = geometry.index ? geometry.index.count : geometry.attributes.position.count
  return Math.round(count / 3)
}

/** Parses an uploaded STL or PLY File into a ready-to-render/-export geometry. */
export async function parseGeometry(file: File): Promise<THREE.BufferGeometry> {
  const format = formatOf(file.name)
  const buffer = await file.arrayBuffer()

  let geometry: THREE.BufferGeometry
  try {
    geometry = format === 'ply' ? new PLYLoader().parse(buffer) : new STLLoader().parse(buffer)
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
