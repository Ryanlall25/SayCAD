import * as THREE from 'three'
import type { ViewerRole } from './viewerTypes'

/**
 * Scan-mesh material construction shared by the Viewer3D component and the
 * SayCAD editor, so a scan renders identically whether it's being viewed
 * or designed against. Moved verbatim from Viewer3D (where the behavior was
 * verified against real 3Shape exports).
 */

/** Neutral gum/stone shade used when a mesh has no vertex colors, and as the
 *  "neutral shaded" override mode for meshes that do. */
export const NEUTRAL_COLOR = 0x8fa79f

/**
 * Material priority per non-bite layer (bite is always metallic silver):
 *  1. UV attribute + companion texture image → texture-mapped material.
 *     This is how real 3Shape PLY arch exports carry color — x/y/z + per-face
 *     texcoords + a `TextureFile` header comment naming a JPG; NO vertex
 *     colors at all.
 *  2. Vertex colors (geometry.hasAttribute('color')) → vertexColors material.
 *     Kept strictly as a fallback: some PLYs genuinely embed per-vertex RGB,
 *     just not this 3Shape export style.
 *  3. Neither → neutral shaded (the STL-style look).
 */
export function makeScanMaterials(
  role: ViewerRole,
  hasColors: boolean,
  texture: THREE.Texture | null
): {
  trueMaterial: THREE.MeshStandardMaterial
  neutralMaterial: THREE.MeshStandardMaterial
} {
  if (role === 'bite') {
    // The bite scan is a positional reference layer, not anatomy — always
    // metallic silver regardless of its own color data, so it reads as
    // distinct from the arches (matches exocad-style articulation views).
    // Same material in both color modes.
    const make = (): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({
        color: 0xc8c8c8,
        metalness: 0.6,
        roughness: 0.3,
        side: THREE.DoubleSide
      })
    return { trueMaterial: make(), neutralMaterial: make() }
  }
  let trueMaterial: THREE.MeshStandardMaterial
  if (texture) {
    trueMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      metalness: 0,
      roughness: 0.6,
      side: THREE.DoubleSide
    })
  } else {
    trueMaterial = new THREE.MeshStandardMaterial({
      // With vertexColors, the base color multiplies the per-vertex data —
      // must stay white or every scan renders darkened/tinted.
      color: hasColors ? 0xffffff : NEUTRAL_COLOR,
      vertexColors: hasColors,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide
    })
  }
  const neutralMaterial = new THREE.MeshStandardMaterial({
    color: NEUTRAL_COLOR,
    metalness: 0.05,
    roughness: 0.65,
    side: THREE.DoubleSide
  })
  return { trueMaterial, neutralMaterial }
}

/**
 * Decodes a companion texture image into a render-ready texture. Failures
 * (corrupt/unsupported image) resolve to null rather than throwing — a bad
 * texture should degrade to neutral shading, not error the whole viewer.
 */
export async function loadTextureFromBlob(blob: Blob): Promise<THREE.Texture | null> {
  const url = URL.createObjectURL(blob)
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url)
    // Scan textures are photographic color data — must be tagged sRGB or the
    // renderer treats them as linear and washes them out.
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
