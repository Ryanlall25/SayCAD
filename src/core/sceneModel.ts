import * as THREE from 'three'
import type { DesignObjectKind } from '../shared/saycad'

/**
 * A placed design object. Its transform lives on the mesh (position/
 * quaternion/scale composed into mesh.matrix) and is NEVER baked into the
 * geometry until export — all manipulation is matrix updates, so undo/redo
 * and re-serialization are lossless.
 */
export interface DesignObject {
  id: string
  kind: DesignObjectKind
  toothNumber?: number
  mesh: THREE.Mesh
  sourceFileId?: string
  sourceName?: string
}

/**
 * The SayCAD scene model: one three.js scene organized into three fixed
 * layers with hard rules.
 *
 *   ScanLayer      — patient scans (upper/lower/bite). LOCKED: never
 *                    selectable, never transformable. Raycastable only, for
 *                    surface snapping and pivot picking.
 *   DesignLayer    — DesignObject meshes. Selectable, transformable.
 *   ReferenceLayer — grid / future planes+annotations. Inert: neither
 *                    raycast set includes it.
 *
 * The plain viewers (Tools single-file, case "View all in 3D") are just this
 * scene with only ScanLayer + ReferenceLayer populated.
 */
export class SayCADScene {
  readonly scene = new THREE.Scene()
  readonly scanLayer = new THREE.Group()
  readonly designLayer = new THREE.Group()
  readonly referenceLayer = new THREE.Group()
  readonly designObjects: DesignObject[] = []

  private readonly raycaster = new THREE.Raycaster()

  constructor() {
    this.scanLayer.name = 'ScanLayer'
    this.designLayer.name = 'DesignLayer'
    this.referenceLayer.name = 'ReferenceLayer'
    this.scene.add(this.scanLayer, this.designLayer, this.referenceLayer)
  }

  addScan(mesh: THREE.Mesh): void {
    mesh.userData.saycadLayer = 'scan'
    this.scanLayer.add(mesh)
  }

  get scanMeshes(): THREE.Mesh[] {
    return this.scanLayer.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
  }

  addReference(object: THREE.Object3D): void {
    object.userData.saycadLayer = 'reference'
    this.referenceLayer.add(object)
  }

  addDesignObject(obj: DesignObject): void {
    obj.mesh.userData.saycadLayer = 'design'
    obj.mesh.userData.designId = obj.id
    this.designLayer.add(obj.mesh)
    this.designObjects.push(obj)
  }

  getDesignObject(id: string): DesignObject | undefined {
    return this.designObjects.find((o) => o.id === id)
  }

  /** Detaches the object from the scene but does NOT dispose its geometry —
   *  the undo stack may re-add the same object (same mesh) later. */
  removeDesignObject(id: string): DesignObject | undefined {
    const idx = this.designObjects.findIndex((o) => o.id === id)
    if (idx < 0) return undefined
    const [obj] = this.designObjects.splice(idx, 1)
    this.designLayer.remove(obj.mesh)
    return obj
  }

  /** First hit on a VISIBLE scan mesh — surface snapping + pivot picking.
   *  Reference layer is deliberately excluded so the grid never swallows
   *  clicks. */
  raycastScans(ndc: THREE.Vector2, camera: THREE.Camera): THREE.Intersection | null {
    this.raycaster.setFromCamera(ndc, camera)
    const visible = this.scanMeshes.filter((m) => m.visible)
    return this.raycaster.intersectObjects(visible, false)[0] ?? null
  }

  /** First hit on a visible design object — selection. Scans are never in
   *  this set: the lock is structural, not a flag check. */
  raycastDesign(
    ndc: THREE.Vector2,
    camera: THREE.Camera
  ): { intersection: THREE.Intersection; object: DesignObject } | null {
    this.raycaster.setFromCamera(ndc, camera)
    const visible = this.designObjects.map((o) => o.mesh).filter((m) => m.visible)
    const hit = this.raycaster.intersectObjects(visible, false)[0]
    if (!hit) return null
    const object = this.designObjects.find((o) => o.mesh === hit.object)
    return object ? { intersection: hit, object } : null
  }

  /** Hit across scans AND design objects (nearest wins) — used by the shared
   *  nav layer (re-pivot / focus / transparency) so every visible surface is
   *  a valid pivot even though only design objects are selectable. */
  raycastAll(ndc: THREE.Vector2, camera: THREE.Camera): THREE.Intersection | null {
    this.raycaster.setFromCamera(ndc, camera)
    const visible = [...this.scanMeshes, ...this.designObjects.map((o) => o.mesh)].filter(
      (m) => m.visible
    )
    return this.raycaster.intersectObjects(visible, false)[0] ?? null
  }

  /** Combined bounds of everything visible (scans + design), world space. */
  visibleBounds(): THREE.Box3 | null {
    const box = new THREE.Box3()
    let any = false
    for (const mesh of [...this.scanMeshes, ...this.designObjects.map((o) => o.mesh)]) {
      if (!mesh.visible) continue
      mesh.updateWorldMatrix(true, false)
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const bb = mesh.geometry.boundingBox
      if (!bb) continue
      box.union(bb.clone().applyMatrix4(mesh.matrixWorld))
      any = true
    }
    return any ? box : null
  }
}
