/**
 * Crown Studio — the crown department on a phone.
 *
 * Flow: load the case (scans or the demo) → tap the prep → the engine finds
 * the margin and designs, checks and shows the crown → adjust by voice,
 * text, AI, sliders or by tapping the crown → review → export STL.
 *
 * Every change — typed, spoken, slider or AI tool call — is a CrownCommand
 * run through one executor, and the crown is always regenerated from
 * (margin, params) in the engine worker, so undo is just "previous params".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type Anthropic from '@anthropic-ai/sdk'
import { StudioViewport, type Pick } from './viewport'
import { CrownEngine } from '../crown/engineClient'
import type { DesignData, MeshData } from '../crown/protocol'
import { DEFAULT_PARAMS, type DesignParams } from '../crown/design'
import type { MarginResult } from '../crown/margin'
import { MATERIALS, type MaterialId } from '../crown/materials'
import { assignRoles, toothFromNames, type FileRole } from '../crown/caseFiles'
import { toothClassOf } from '../crown/anatomy'
import { parseGeometry, exportSTL } from '../core/meshConvert'
import { CROWN_HELP, parseCrown, type CrownCommand, type NumericParam } from '../speak/crownParser'
import { createDictation } from '../speak/voice'
import {
  accessCode,
  aiReview,
  aiStatus,
  artifactDownloads,
  artifactSample,
  assist,
  assistViaSample,
  photoToBase64,
  readRx,
  reviewViaSample,
  rxViaSample,
  sampleErrorText,
  setAccessCode,
  type DownloadsApi,
  type SampleFn
} from '../ai/client'
import { zip } from '../core/zip'
import { clearModels, deleteCase, listCases, loadCase, loadModel, newCaseId, saveCase, saveModel, updateCase, type CaseMeta } from './caseStore'
import './studio.css'

type Step = 'case' | 'margin' | 'design' | 'check' | 'export'
const STEPS: Array<[Step, string]> = [
  ['case', 'Case'],
  ['margin', 'Margin'],
  ['design', 'Design'],
  ['check', 'Check'],
  ['export', 'Export']
]

interface ScanFile {
  name: string
  role: FileRole
  geometry: THREE.BufferGeometry
}

interface Snapshot {
  params: DesignParams
  flip: boolean
  margin: MarginResult | null
}

interface ChatLine {
  who: 'you' | 'ai' | 'app'
  text: string
}

const PARAM_RANGES: Record<NumericParam, [number, number]> = {
  contactMesialMm: [-0.15, 0.3],
  contactDistalMm: [-0.15, 0.3],
  occlusalClearanceMm: [-0.05, 0.5],
  cuspScale: [0.5, 1.6],
  grooveScale: [0, 2.5],
  buccalBulgeMm: [-0.5, 0.8],
  lingualBulgeMm: [-0.5, 0.8],
  heightOffsetMm: [-1, 1],
  rotationDeg: [-25, 25],
  mdShiftMm: [-1, 1],
  blShiftMm: [-1, 1],
  cementGapMm: [0, 0.15],
  axisTiltMesialDeg: [-15, 15],
  axisTiltBuccalDeg: [-15, 15]
}

const LAB_NAME = 'SmileHub'

function meshData(g: THREE.BufferGeometry): MeshData {
  return {
    positions: (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
    indices: g.index ? (g.index.array as Uint32Array) : null
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const fmt = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))

export default function CrownStudio(): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<StudioViewport | null>(null)
  const engineRef = useRef<CrownEngine | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rxRef = useRef<HTMLInputElement>(null)
  const libRef = useRef<HTMLInputElement>(null)
  const [libNote, setLibNote] = useState<string | null>(null)
  const [modelsVersion, setModelsVersion] = useState(0)

  const [step, setStep] = useState<Step>('case')
  const [tooth, setTooth] = useState<number>(19)
  const [files, setFiles] = useState<ScanFile[]>([])
  const [loaded, setLoaded] = useState(false)
  const [params, setParams] = useState<DesignParams>({ ...DEFAULT_PARAMS })
  const [flip, setFlip] = useState(false)
  const [margin, setMargin] = useState<MarginResult | null>(null)
  const [design, setDesign] = useState<DesignData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('Load a case, or try the demo.')
  const [editMargin, setEditMargin] = useState(false)
  const [sculptAt, setSculptAt] = useState<{ i: number; j: number; point: [number, number, number] } | null>(null)
  const [sculptRadius, setSculptRadius] = useState(1.5)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  // AI comes from the SayCAD server (API key on the server) or, when the app
  // is hosted on claude.ai, from the artifact runtime on the viewer's account.
  const [ai, setAi] = useState<{ ai: boolean; mode: 'server' | 'artifact' | 'off'; needsCode: boolean; model?: string; images: boolean }>({ ai: false, mode: 'off', needsCode: false, images: false })
  const sampleRef = useRef<SampleFn | null>(null)
  const downloadsRef = useRef<DownloadsApi | null>(null)
  const sampleChat = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [code, setCode] = useState(accessCode())
  const [review, setReview] = useState<string | null>(null)
  const [rxNote, setRxNote] = useState<string | null>(null)
  const [model, setModel] = useState<{ json: string; count: number; source: string } | null>(null)
  const [useLearned, setUseLearned] = useState(true)
  const [alignZ, setAlignZ] = useState(false)
  const [override, setOverride] = useState('')
  const [sheetOpen, setSheetOpen] = useState(true)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [recent, setRecent] = useState<CaseMeta[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // Mutable mirrors for async code paths.
  const state = useRef({ params, flip, margin, design, tooth, step, loaded, useLearned, model, sculptAt, caseId })
  state.current = { params, flip, margin, design, tooth, step, loaded, useLearned, model, sculptAt, caseId }
  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])
  const aiHistory = useRef<Anthropic.Beta.BetaMessageParam[]>([])
  const running = useRef(false)
  const queued = useRef<null | (() => void)>(null)
  const previewTimer = useRef<number | undefined>(undefined)
  const finalTimer = useRef<number | undefined>(undefined)

  const say = useCallback((who: ChatLine['who'], text: string) => setChat((c) => [...c.slice(-30), { who, text }]), [])

  /* ── setup ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const v = new StudioViewport(mount)
    viewRef.current = v
    engineRef.current = new CrownEngine()
    void listCases().then(setRecent)
    void (async () => {
      const st = await aiStatus()
      if (st.ai) return setAi({ ai: true, mode: 'server', needsCode: st.needsCode, model: st.model, images: true })
      const [sample, downloads] = await Promise.all([artifactSample(), artifactDownloads()])
      downloadsRef.current = downloads
      if (sample) {
        sampleRef.current = sample
        const lim = await sample.limits().catch(() => null)
        setAi({ ai: true, mode: 'artifact', needsCode: false, model: 'Claude (your account)', images: Boolean(lim?.images) })
      } else setAi((a) => ({ ...a, needsCode: st.needsCode }))
    })()
    return () => {
      v.dispose()
      engineRef.current?.dispose()
      viewRef.current = null
    }
  }, [])

  // Learned anatomy for the tooth's class, if the lab has trained one.
  useEffect(() => {
    let cancelled = false
    const cls = toothClassOf(tooth)
    const use = (txt: string): void => {
      try {
        const m = JSON.parse(txt) as { count: number; source?: string }
        setModel({ json: txt, count: m.count, source: m.source ?? `${m.count} cases` })
      } catch {
        setModel(null)
      }
    }
    void loadModel(cls).then((stored) => {
      if (cancelled) return
      if (stored) return use(stored)
      fetch(`${import.meta.env.BASE_URL}models/ssm-${cls}.json`)
      .then((r) => (r.ok ? r.text() : null))
      .then((txt) => {
        if (cancelled) return
        if (!txt || !txt.trim().startsWith('{')) return setModel(null)
        try {
          const m = JSON.parse(txt) as { count: number; source?: string }
          setModel({ json: txt, count: m.count, source: m.source ?? `${m.count} cases` })
        } catch {
          setModel(null)
        }
      })
      .catch(() => !cancelled && setModel(null))
    })
    return () => {
      cancelled = true
    }
  }, [tooth, modelsVersion])

  /* ── engine calls ──────────────────────────────────────────────────── */

  const runDesign = useCallback(
    (quality: 'preview' | 'final' = 'final', override?: Partial<Snapshot>): Promise<DesignData | null> => {
      const s = state.current
      const m = override?.margin ?? s.margin
      if (!m) return Promise.resolve(null)
      const p = override?.params ?? s.params
      const f = override?.flip ?? s.flip
      return new Promise((resolve) => {
        const go = (): void => {
          running.current = true
          if (quality === 'final') setBusy('Designing…')
          const modelJson = s.useLearned && s.model ? s.model.json : null
          engineRef.current!
            .design(m, p, f, quality, modelJson)
            .then((d) => {
              setDesign(d)
              const mat = MATERIALS[d.params.material]
              viewRef.current?.setCrown(d, d.params.minAxialMm ?? mat.minAxialMm, d.params.minOcclusalMm ?? mat.minOcclusalMm)
              viewRef.current?.setFrame(d.frame)
              viewRef.current?.setMargin(d.margin.points, d.margin.confidence)
              const fails = d.results.filter((r) => r.verdict === 'fail').length
              const warns = d.results.filter((r) => r.verdict === 'warn').length
              if (quality === 'final' && state.current.caseId) {
                void updateCase(state.current.caseId, { params: p, flip: f, margin: m, tooth: state.current.tooth, status: fails ? `${fails} fail` : warns ? `${warns} to check` : 'QC ✓' }).then(() => listCases().then(setRecent))
              }
              if (quality === 'final')
                setStatus(fails ? `${fails} check(s) failing — see Check.` : warns ? `Designed. ${warns} item(s) to look at.` : 'Designed — all checks pass.')
              resolve(d)
            })
            .catch((e: Error) => {
              setStatus(e.message)
              resolve(null)
            })
            .finally(() => {
              running.current = false
              setBusy(null)
              const next = queued.current
              queued.current = null
              next?.()
            })
        }
        if (running.current) queued.current = go
        else go()
      })
    },
    []
  )

  const pushHistory = (): void => {
    const s = state.current
    undoStack.current.push({ params: s.params, flip: s.flip, margin: s.margin })
    if (undoStack.current.length > 60) undoStack.current.shift()
    redoStack.current = []
  }

  const applySnapshot = (snap: Snapshot): Promise<DesignData | null> => {
    setParams(snap.params)
    setFlip(snap.flip)
    setMargin(snap.margin)
    return runDesign('final', snap)
  }

  async function commitScans(list: ScanFile[], t: number, restore?: CaseMeta): Promise<void> {
    const prep = list.find((f) => f.role === 'prep')
    const ant = list.find((f) => f.role === 'antagonist')
    const v = viewRef.current
    if (!prep || !v) {
      setStatus('Which file is the prepared arch? Set its role to “prep”.')
      return
    }
    setBusy('Preparing scans…')
    try {
      v.setScan(prep.geometry)
      v.setAntagonist(ant?.geometry ?? null)
      v.setCrown(null)
      v.setMargin(null)
      v.setFrame(null)
      v.setMarker(null)
      const r = await engineRef.current!.load(t, meshData(prep.geometry), ant ? meshData(ant.geometry) : null)
      setLoaded(true)
      setMargin(null)
      setDesign(null)
      undoStack.current = []
      redoStack.current = []
      v.view('fit', false)
      fitToScan(prep.geometry)
      setStep('margin')
      setStatus(`Scans ready (${(r.triangles / 1000).toFixed(0)}k triangles). Tap the prepared tooth.`)
      if (restore) {
        setCaseId(restore.id)
        state.current.caseId = restore.id
        // Cases saved by older versions may lack newer parameters.
        const restored: DesignParams = { ...DEFAULT_PARAMS, ...restore.params }
        setParams(restored)
        if (restore.flip !== undefined) setFlip(restore.flip)
        if (restore.margin) {
          setMargin(restore.margin)
          setStep('design')
          await runDesign('final', { margin: restore.margin, params: restored, flip: restore.flip ?? false })
          viewRef.current?.view('buccal')
        }
      } else {
        // Keep the case on this device so it can be reopened later.
        const id = newCaseId()
        setCaseId(id)
        state.current.caseId = id
        const now = new Date().toISOString()
        const stem = list[0]?.name.replace(/\.(stl|ply)$/i, '').slice(0, 28) ?? 'case'
        const ok = await saveCase(
          { id, name: `#${t} · ${stem}`, tooth: t, createdAt: now, updatedAt: now },
          list.filter((f) => f.role === 'prep' || f.role === 'antagonist').map((f) => {
            const m = meshData(f.geometry)
            return { name: f.name, role: f.role, positions: m.positions.slice().buffer, indices: m.indices ? m.indices.slice().buffer : null }
          })
        )
        if (ok) void listCases().then(setRecent)
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  function fitToScan(g: THREE.BufferGeometry): void {
    const v = viewRef.current
    if (!v) return
    g.computeBoundingSphere()
    const s = g.boundingSphere!
    v.camera.position.set(s.center.x, s.center.y + s.radius * 1.6, s.center.z + s.radius * 1.4)
    v.camera.up.set(0, 1, 0)
    v.camera.lookAt(s.center)
  }

  async function onFiles(list: FileList | null): Promise<void> {
    if (!list || !list.length) return
    setBusy('Reading files…')
    const parsed: ScanFile[] = []
    const names = Array.from(list).map((f) => f.name)
    const t = toothFromNames(names) ?? tooth
    const roles = assignRoles(names, { toothNumber: t })
    for (const f of Array.from(list)) {
      try {
        const g = await parseGeometry(f)
        parsed.push({ name: f.name, role: roles[f.name] === 'ignore' ? 'prep' : roles[f.name], geometry: g })
      } catch (e) {
        setStatus(`${f.name}: ${e instanceof Error ? e.message : 'unreadable'}`)
      }
    }
    // Exactly one prep: if guessing produced none or several, keep the first.
    if (!parsed.some((p) => p.role === 'prep') && parsed[0]) parsed[0].role = 'prep'
    let seenPrep = false
    for (const p of parsed) {
      if (p.role === 'prep') {
        if (seenPrep) p.role = 'antagonist'
        seenPrep = true
      }
    }
    setTooth(t)
    setFiles(parsed)
    setBusy(null)
    setStatus(`${parsed.length} file(s) read — check the roles, then “Use these scans”.`)
  }

  async function importLibrary(list: FileList | null): Promise<void> {
    if (!list || !list.length) return
    const picked = Array.from(list) // the input is cleared right after this call
    setBusy(`Reading ${picked.length} library file(s)…`)
    try {
      const files: Array<{ name: string; mesh: MeshData }> = []
      for (const f of picked) {
        try {
          files.push({ name: f.name, mesh: meshData(await parseGeometry(f)) })
        } catch {
          /* unreadable file: reported as skipped below */
        }
      }
      setBusy('Learning the library’s tooth forms…')
      const r = await engineRef.current!.importLibrary(files, 'auto', 'tooth library')
      for (const [cls, json] of Object.entries(r.models)) await saveModel(cls, json)
      const ok = r.teeth.filter((t) => t.ok)
      const bad = r.teeth.filter((t) => !t.ok)
      setLibNote(
        `${ok.length} teeth imported → ${Object.keys(r.models).length} tooth classes now use the library.` +
          (bad.length ? ` Not used: ${bad.map((t) => `${t.name} (${t.error})`).join(', ')}.` : '') +
          (r.skipped.length ? ` No tooth number in: ${r.skipped.join(', ')}.` : '')
      )
      setModelsVersion((v) => v + 1)
      if (state.current.margin) setTimeout(() => void runDesign('final'), 0)
    } catch (e) {
      setLibNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function openCase(id: string): Promise<void> {
    setBusy('Opening case…')
    const c = await loadCase(id)
    if (!c) {
      setBusy(null)
      setStatus('That case could not be opened on this device.')
      return
    }
    const list: ScanFile[] = c.scans.map((sc) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sc.positions), 3))
      if (sc.indices) g.setIndex(new THREE.BufferAttribute(new Uint32Array(sc.indices), 1))
      return { name: sc.name, role: sc.role, geometry: g }
    })
    setFiles(list)
    setTooth(c.meta.tooth)
    await commitScans(list, c.meta.tooth, c.meta)
    say('app', `Opened ${c.meta.name}.`)
  }

  async function removeCase(id: string): Promise<void> {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    setConfirmDelete(null)
    await deleteCase(id)
    if (state.current.caseId === id) setCaseId(null)
    setRecent(await listCases())
  }

  async function loadDemo(autoTap = false): Promise<void> {
    setBusy('Building the demo case…')
    await new Promise((r) => setTimeout(r, 30))
    const { syntheticMolarCase } = await import('../crown/synthetic')
    const c = syntheticMolarCase()
    const list: ScanFile[] = [
      { name: 'demo-lowerjaw.stl', role: 'prep', geometry: c.prep },
      { name: 'demo-upperjaw.stl', role: 'antagonist', geometry: c.antagonist }
    ]
    setFiles(list)
    setTooth(19)
    await commitScans(list, 19)
    say('app', 'Demo case: lower-left first molar (#19), full-crown prep. Tap the prep to start.')
    if (autoTap) await tapPrep(c.tapPoint)
  }

  async function tapPrep(point: [number, number, number]): Promise<void> {
    setBusy('Finding the margin…')
    try {
      const m = await engineRef.current!.margin(point)
      pushHistory()
      setMargin(m)
      viewRef.current?.setMargin(m.points, m.confidence)
      const low = m.confidence.filter((c) => c < 0.35).length
      setStatus(low ? `Margin found — ${low} uncertain sample(s) in red. Designing…` : 'Margin found. Designing…')
      setStep('design')
      const d = await runDesign('final', { margin: m })
      if (d) viewRef.current?.view('buccal')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  async function onTap(p: Pick | null): Promise<void> {
    const s = state.current
    if (!p || !s.loaded) return
    if (p.target === 'scan' && (s.step === 'margin' || !s.margin)) {
      if (s.margin && editMargin) {
        setBusy('Moving the margin…')
        try {
          const pts = await engineRef.current!.editMargin(s.margin.points, p.point)
          pushHistory()
          const m: MarginResult = { ...s.margin, points: pts, confidence: s.margin.confidence.map((c, k) => (Math.hypot(...sub(pts[k], s.margin!.points[k])) > 0.02 ? 1 : c)) }
          setMargin(m)
          viewRef.current?.setMargin(m.points, m.confidence)
          await runDesign('final', { margin: m })
        } finally {
          setBusy(null)
        }
        return
      }
      if (!s.margin) await tapPrep(p.point)
      return
    }
    if (p.target === 'crown' && s.design && p.vertex !== undefined && p.vertex < s.design.nu * s.design.nv) {
      const i = p.vertex % s.design.nu
      const j = Math.floor(p.vertex / s.design.nu)
      setSculptAt({ i, j, point: p.point })
      viewRef.current?.setMarker(p.point, sculptRadius)
      if (s.step !== 'design') setStep('design')
    }
  }

  useEffect(() => {
    viewRef.current?.onTap((p) => void onTap(p))
  })

  /* ── the executor ──────────────────────────────────────────────────── */

  function paramChange(cmd: Extract<CrownCommand, { kind: 'param' }>): DesignParams {
    const p = state.current.params
    const [lo, hi] = PARAM_RANGES[cmd.param]
    const current = cmd.param === 'cementGapMm' ? p.cementGapMm ?? MATERIALS[p.material].cementGapMm : (p[cmd.param] as number)
    const next = Math.min(hi, Math.max(lo, cmd.mode === 'set' ? cmd.value : current + cmd.value))
    return { ...p, [cmd.param]: Math.round(next * 1000) / 1000 }
  }

  function checksText(d: DesignData | null): string {
    if (!d) return 'No design yet.'
    return d.results.map((r) => `${r.verdict.toUpperCase()} ${r.label}: ${r.measured} (need ${r.required})${r.fix ? ` → ${r.fix}` : ''}`).join('\n')
  }

  async function redesignWith(next: Partial<Snapshot>, label: string): Promise<string> {
    if (!state.current.margin) {
      if (next.params) setParams(next.params)
      if (next.flip !== undefined) setFlip(next.flip)
      return `${label} — will apply once the margin is found (tap the prep).`
    }
    pushHistory()
    if (next.params) setParams(next.params)
    if (next.flip !== undefined) setFlip(next.flip)
    const d = await runDesign('final', next)
    if (!d) return `${label}, but the design failed.`
    const fails = d.results.filter((r) => r.verdict === 'fail')
    return `${label}. Checks: ${fails.length ? fails.map((f) => `${f.label} ${f.measured}`).join('; ') + ' failing' : 'all critical checks pass'}. Contacts M ${fmt(d.summary.mesialContactMm, 3)} / D ${fmt(d.summary.distalContactMm, 3)} mm, occlusal min ${fmt(d.summary.occlusalMinMm, 3)} mm, thickness ${fmt(d.summary.minAxialThicknessMm)} axial / ${fmt(d.summary.minOcclusalThicknessMm)} occlusal mm.`
  }

  async function execute(cmd: CrownCommand | { kind: 'getChecks' }): Promise<string> {
    const s = state.current
    const v = viewRef.current
    switch (cmd.kind) {
      case 'setTooth': {
        setTooth(cmd.tooth)
        await engineRef.current?.setTooth(cmd.tooth)
        if (s.margin) await runDesign('final')
        return `Tooth set to #${cmd.tooth}.`
      }
      case 'autoDesign': {
        if (!s.loaded) return 'Load the scans first (or the demo case).'
        if (!s.margin) return 'Tap the prepared tooth on the scan first — that finds the margin and designs.'
        const d = await runDesign('final')
        setStep('design')
        return d ? 'Redesigned from scratch.' : 'Design failed.'
      }
      case 'param': {
        const p = paramChange(cmd)
        return redesignWith({ params: p }, `${cmd.param} → ${(p[cmd.param] ?? 0).toString()}`)
      }
      case 'material': {
        if (!MATERIALS[cmd.material]) return 'Unknown material.'
        return redesignWith({ params: { ...s.params, material: cmd.material, cementGapMm: undefined } }, `Material: ${MATERIALS[cmd.material].label}`)
      }
      case 'occlusalContacts':
        return redesignWith({ params: { ...s.params, occlusalContacts: cmd.on } }, cmd.on ? 'Occlusal contacts on' : 'Out of occlusion')
      case 'sculpt': {
        const op = { region: cmd.region, amountMm: cmd.amountMm, radiusMm: cmd.radiusMm }
        return redesignWith({ params: { ...s.params, sculpt: [...s.params.sculpt, op] } }, `${cmd.amountMm > 0 ? 'Added' : 'Removed'} ${Math.abs(cmd.amountMm).toFixed(2)} mm at ${cmd.region}`)
      }
      case 'flipBuccal':
        return redesignWith({ flip: !s.flip }, 'Buccal flipped')
      case 'view':
        v?.view(cmd.view)
        return `Showing ${cmd.view}.`
      case 'layer': {
        const on = v?.setLayer(cmd.layer, cmd.visible)
        return `${cmd.layer} ${on ? 'shown' : 'hidden'}.`
      }
      case 'check':
        setStep('check')
        return checksText(s.design)
      case 'getChecks':
        return checksText(s.design)
      case 'export':
        setStep('export')
        return s.design?.exportable ? 'Ready to export — tap Download STL.' : 'Some checks fail; export needs an override reason.'
      case 'undo': {
        const snap = undoStack.current.pop()
        if (!snap) return 'Nothing to undo.'
        redoStack.current.push({ params: s.params, flip: s.flip, margin: s.margin })
        await applySnapshot(snap)
        return 'Undone.'
      }
      case 'redo': {
        const snap = redoStack.current.pop()
        if (!snap) return 'Nothing to redo.'
        undoStack.current.push({ params: s.params, flip: s.flip, margin: s.margin })
        await applySnapshot(snap)
        return 'Redone.'
      }
      case 'demo':
        await loadDemo()
        return 'Demo case loaded.'
      case 'review':
        await runReview()
        return 'Review requested.'
      case 'help':
        setHelpOpen((o) => !o)
        return 'Help toggled.'
      case 'unknown':
        return `Didn't catch “${cmd.text}”.`
    }
  }

  function stateSummary(): string {
    const s = state.current
    const d = s.design
    const lines = [
      `tooth #${s.tooth} (${toothClassOf(s.tooth)}), material ${s.params.material}`,
      `scans loaded: ${s.loaded}; margin found: ${Boolean(s.margin)}; design: ${d ? 'yes' : 'no'}`,
      `params: ${JSON.stringify({ ...s.params, sculpt: s.params.sculpt.length })}`
    ]
    if (d) lines.push(`checks:\n${checksText(d)}`, `cusps available: ${d.cuspTips.map((c) => c.name).join(', ')}`)
    return lines.join('\n')
  }

  async function submit(text: string): Promise<void> {
    const t = text.trim()
    if (!t) return
    setInput('')
    setInterim('')
    say('you', t)
    const cmd = parseCrown(t)
    if (cmd.kind !== 'unknown') {
      const out = await execute(cmd)
      say('app', out.split('\n')[0])
      return
    }
    if (!ai.ai) {
      say('app', `Didn't catch that. Say “help” for what I understand${ai.needsCode ? '' : ' — or set up the AI server for free-form requests'}.`)
      return
    }
    setBusy('Thinking…')
    try {
      const r =
        ai.mode === 'artifact' && sampleRef.current
          ? await assistViaSample(sampleRef.current, sampleChat.current, t, stateSummary(), execute)
          : await assist(aiHistory.current, t, stateSummary(), execute)
      say('ai', r.reply)
    } catch (e) {
      say('app', ai.mode === 'artifact' ? sampleErrorText(e) : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /* ── AI review / Rx ────────────────────────────────────────────────── */

  async function runReview(): Promise<void> {
    const s = state.current
    const v = viewRef.current
    if (!s.design || !v) {
      setReview('Design a crown first.')
      return
    }
    if (!ai.ai) {
      setReview('AI review needs the SayCAD server with an Anthropic API key, or the app opened on claude.ai (see README).')
      return
    }
    setBusy('AI reviewing…')
    setStep('check')
    try {
      const images = (['buccal', 'occlusal', 'lingual'] as const).map((view) => ({ mediaType: 'image/png' as const, data: v.snapshot(view) }))
      const payload = {
        tooth: s.tooth,
        material: MATERIALS[s.params.material].label,
        report: s.design.results,
        measures: { ...s.design.measures, steps: undefined, summary: s.design.summary },
        images
      }
      setReview(ai.mode === 'artifact' && sampleRef.current ? await reviewViaSample(sampleRef.current, payload) : await aiReview(payload))
    } catch (e) {
      setReview(ai.mode === 'artifact' ? sampleErrorText(e) : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onRxPhoto(f: File | undefined): Promise<void> {
    if (!f) return
    setBusy('Reading the Rx…')
    try {
      const fields = ai.mode === 'artifact' && sampleRef.current ? await rxViaSample(sampleRef.current, f) : await readRx(await photoToBase64(f))
      const t = fields.teeth.find((n) => n >= 1 && n <= 32)
      if (t) await execute({ kind: 'setTooth', tooth: t })
      if (fields.material && MATERIALS[fields.material]) setParams((p) => ({ ...p, material: fields.material as MaterialId, cementGapMm: undefined }))
      setRxNote(
        [
          fields.teeth.length ? `Teeth: ${fields.teeth.map((n) => `#${n}`).join(', ')}` : null,
          fields.restoration ? `Restoration: ${fields.restoration}` : null,
          fields.material ? `Material: ${MATERIALS[fields.material]?.label ?? fields.material}` : null,
          fields.shade ? `Shade: ${fields.shade}` : null,
          fields.notes ? `Notes: ${fields.notes}` : null
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing legible found on the Rx.'
      )
    } catch (e) {
      setRxNote(ai.mode === 'artifact' ? sampleErrorText(e) : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /* ── sliders & sculpt ──────────────────────────────────────────────── */

  function slide(param: NumericParam, value: number): void {
    const p = { ...state.current.params, [param]: value }
    setParams(p)
    window.clearTimeout(previewTimer.current)
    window.clearTimeout(finalTimer.current)
    previewTimer.current = window.setTimeout(() => void runDesign('preview', { params: p }), 120)
    finalTimer.current = window.setTimeout(() => {
      pushHistory()
      void runDesign('final', { params: p })
    }, 900)
  }

  async function sculptHere(amount: number): Promise<void> {
    const at = state.current.sculptAt
    if (!at) return
    const op = { at: { i: at.i, j: at.j }, amountMm: amount, radiusMm: sculptRadius }
    const out = await redesignWith({ params: { ...state.current.params, sculpt: [...state.current.params.sculpt, op] } }, `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} mm`)
    setStatus(out.split('.')[0] + '.')
  }

  /* ── export ────────────────────────────────────────────────────────── */

  function crownGeometry(): THREE.BufferGeometry | null {
    const d = state.current.design
    if (!d) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(d.crown.positions.slice(), 3))
    if (d.crown.indices) g.setIndex(new THREE.BufferAttribute(d.crown.indices.slice(), 1))
    if (alignZ) {
      // Insertion axis → +Z, origin at the margin centroid (for CAM nesting).
      const f = d.frame
      const toLocal = new THREE.Matrix4().set(
        f.mesial[0], f.mesial[1], f.mesial[2], 0,
        f.buccal[0], f.buccal[1], f.buccal[2], 0,
        f.occlusal[0], f.occlusal[1], f.occlusal[2], 0,
        0, 0, 0, 1
      )
      g.translate(-f.origin[0], -f.origin[1], -f.origin[2])
      g.applyMatrix4(toLocal)
      if (toLocal.determinant() < 0 && g.index) {
        const idx = g.index.array as Uint32Array
        for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]]
      }
    }
    return g
  }

  function baseName(): string {
    const s = state.current
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    return `${LAB_NAME}_crown_${s.tooth}_${s.params.material}_${date}`
  }

  function designRecord(): string {
    const s = state.current
    return JSON.stringify(
      {
        app: 'SayCAD Crowns',
        version: 1,
        createdAt: new Date().toISOString(),
        tooth: s.tooth,
        files: files.map((f) => ({ name: f.name, role: f.role })),
        params: s.params,
        flipBuccal: s.flip,
        margin: s.margin?.points,
        anatomy: s.useLearned && s.model ? `learned — ${s.model.source}` : 'textbook',
        checks: s.design?.results,
        exportOverride: s.design && !s.design.exportable ? override : undefined
      },
      null,
      1
    )
  }

  async function exportCrown(share: boolean): Promise<void> {
    const g = crownGeometry()
    if (!g) return
    const blob = exportSTL(g)
    const name = `${baseName()}.stl`
    // claude.ai-hosted: downloads go through the runtime, which accepts .zip
    // but not .stl — bundle the STL with its design record.
    if (downloadsRef.current) {
      const archive = zip([
        { name, data: new Uint8Array(await blob.arrayBuffer()) },
        { name: `${baseName()}.design.json`, data: new TextEncoder().encode(designRecord()) }
      ])
      try {
        await downloadsRef.current.save({ filename: `${baseName()}.zip`, data: new Blob([archive], { type: 'application/zip' }) })
        setStatus(`Saved ${baseName()}.zip (STL + design record).`)
      } catch (e) {
        const code = (e as { code?: string }).code
        setStatus(code === 'declined' ? 'Download cancelled.' : `Download unavailable here (${code ?? 'error'}).`)
      }
      return
    }
    if (share && navigator.canShare) {
      const file = new File([blob], name, { type: 'model/stl' })
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name })
          return
        } catch {
          /* cancelled → fall through to download */
        }
      }
    }
    download(blob, name)
    download(new Blob([designRecord()], { type: 'application/json' }), `${baseName()}.design.json`)
    setStatus(`Exported ${name}.`)
  }

  /* ── voice ─────────────────────────────────────────────────────────── */
  const dictationRef = useRef<ReturnType<typeof createDictation> | null>(null)
  if (!dictationRef.current && typeof window !== 'undefined') {
    dictationRef.current = createDictation({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => void submit(t),
      onStateChange: (on) => setListening(on),
      onError: (m) => setStatus(m)
    })
  }
  const dictation = dictationRef.current

  /* ── render ────────────────────────────────────────────────────────── */
  // Inside claude.ai the frame refuses the microphone; the phone keyboard's
  // own dictation key still types into the command box.
  const framed = typeof window !== 'undefined' && window.top !== window
  const d = design
  const counts = d ? { pass: d.results.filter((r) => r.verdict === 'pass').length, warn: d.results.filter((r) => r.verdict === 'warn').length, fail: d.results.filter((r) => r.verdict === 'fail').length } : null

  return (
    <div className="studio">
      <header className="st-head">
        <div className="st-brand">
          <span className="st-lab">{LAB_NAME}</span>
          <span className="st-dept">Crowns</span>
        </div>
        <span className="st-spacer" />
        <button className="st-chip" onClick={() => setStep('case')} title="Tooth">#{tooth}</button>
        {counts && (
          <button className={`st-chip ${counts.fail ? 'bad' : counts.warn ? 'meh' : 'good'}`} onClick={() => setStep('check')}>
            {counts.fail ? `${counts.fail} fail` : counts.warn ? `${counts.warn} to check` : 'QC ✓'}
          </button>
        )}
        <span className={`st-chip ${ai.ai ? 'ai' : 'off'}`} title={ai.ai ? `AI: ${ai.model ?? 'on'}` : 'No AI connected (server or claude.ai)'}>AI {ai.ai ? 'on' : 'off'}</span>
        <button className="st-icon" onClick={() => setHelpOpen((o) => !o)} aria-label="Help">?</button>
      </header>

      <div className="st-stage" ref={mountRef}>
        {busy && (
          <div className="st-busy">
            <span className="st-spin" /> {busy}
          </div>
        )}
        {!loaded && !busy && (
          <div className="st-empty">
            <h1>Design a crown on your phone</h1>
            <p>Load the case scans, tap the prepared tooth, and the engine finds the margin, designs the crown and checks it.</p>
            <div className="st-row">
              <button className="st-primary" onClick={() => fileRef.current?.click()}>Load scans</button>
              <button className="st-secondary" onClick={() => void loadDemo(true)}>Try the demo</button>
            </div>
          </div>
        )}
        {loaded && (
          <div className="st-views">
            {(['occlusal', 'buccal', 'lingual', 'mesial', 'distal'] as const).map((v) => (
              <button key={v} onClick={() => viewRef.current?.view(v)} title={v}>{v[0].toUpperCase()}</button>
            ))}
            <span className="sep" />
            <button onClick={() => setLayerState('antagonist')} title="Antagonist">A</button>
            <button onClick={() => setLayerState('heatmap')} title="Thickness map">T</button>
          </div>
        )}
        {(listening || interim) && <div className="st-transcript">{interim || 'Listening…'}</div>}
        {helpOpen && (
          <aside className="st-help">
            <h2>How it works</h2>
            <ol>
              <li>Load the prep-arch scan and the opposing scan (STL/PLY), or the demo.</li>
              <li>Tap the prepared tooth. The margin, crown, contacts, occlusion and thickness are done for you.</li>
              <li>Adjust by talking, typing, the sliders, or by tapping the crown and adding/removing.</li>
              <li>Check, then export the STL for milling.</li>
            </ol>
            <h2>Things you can say</h2>
            <table>
              <tbody>
                {CROWN_HELP.map(([s, d2]) => (
                  <tr key={s}>
                    <td>“{s}”</td>
                    <td>{d2}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="st-fine">
              {ai.ai ? 'Anything else goes to Claude, which edits the design with the same commands.' : 'With the AI server running, anything else you say goes to Claude.'} One finger turns the model, two fingers zoom and pan.
            </p>
            <button className="st-secondary" onClick={() => setHelpOpen(false)}>Close</button>
          </aside>
        )}
      </div>

      <section className={`st-sheet ${sheetOpen ? '' : 'closed'}`}>
        <nav className="st-tabs">
          {STEPS.map(([k, label], n) => (
            <button key={k} className={step === k ? 'on' : ''} onClick={() => { setStep(k); setSheetOpen(true) }}>
              <span>{n + 1}</span> {label}
            </button>
          ))}
          <button className="st-collapse" onClick={() => setSheetOpen((o) => !o)} aria-label="Toggle panel">{sheetOpen ? '▾' : '▴'}</button>
        </nav>
        {sheetOpen && (
          <div className="st-panel">
            {step === 'case' && (
              <div className="st-stack">
                <label className="st-field">
                  <span>Tooth (Universal)</span>
                  <select value={tooth} onChange={(e) => void execute({ kind: 'setTooth', tooth: Number(e.target.value) })}>
                    {Array.from({ length: 32 }, (_, k) => k + 1).map((n) => (
                      <option key={n} value={n}>#{n} — {toothClassOf(n).replace(/([A-Z])/g, ' $1').toLowerCase()}</option>
                    ))}
                  </select>
                </label>
                <label className="st-field">
                  <span>Material</span>
                  <select value={params.material} onChange={(e) => void execute({ kind: 'material', material: e.target.value as MaterialId })}>
                    {Object.values(MATERIALS).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <p className="st-fine">{MATERIALS[params.material].note} Min {MATERIALS[params.material].minAxialMm} mm axial / {MATERIALS[params.material].minOcclusalMm} mm occlusal, cement {MATERIALS[params.material].cementGapMm} mm.</p>
                <div className="st-row">
                  <button className="st-primary" onClick={() => fileRef.current?.click()}>Add scans</button>
                  <button className="st-secondary" onClick={() => void loadDemo()}>Demo case</button>
                  <button className="st-secondary" onClick={() => rxRef.current?.click()} disabled={!ai.ai || !ai.images} title={ai.ai && ai.images ? 'Photo of the Rx' : 'Needs AI with image access'}>Read Rx photo</button>
                </div>
                {rxNote && <p className="st-note">{rxNote}</p>}
                <div className="st-stack">
                  <div className="st-row">
                    <button className="st-secondary" onClick={() => libRef.current?.click()}>Import tooth library</button>
                    {model && <button className="st-link" onClick={() => void clearModels().then(() => { setLibNote('Imported libraries removed from this device.'); setModelsVersion((v) => v + 1) })}>Remove imported</button>}
                  </div>
                  <p className="st-fine">Select all of a library’s tooth STLs at once (names must contain the tooth number, Universal or FDI). The forms become the starting anatomy for each tooth class, kept on this device only. Use libraries you’re licensed to use.</p>
                  {libNote && <p className="st-note">{libNote}</p>}
                </div>
                {recent.length > 0 && (
                  <div className="st-recent">
                    <h3>Cases on this device</h3>
                    {recent.slice(0, 12).map((c) => (
                      <div key={c.id} className={`st-case ${c.id === caseId ? 'on' : ''}`}>
                        <button className="st-case-open" onClick={() => void openCase(c.id)}>
                          <b>{c.name}</b>
                          <span>{new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{c.status ? ` · ${c.status}` : ''}</span>
                        </button>
                        <button className="st-link" onClick={() => void removeCase(c.id)}>{confirmDelete === c.id ? 'Tap again to delete' : 'Delete'}</button>
                      </div>
                    ))}
                  </div>
                )}
                {files.length > 0 && (
                  <div className="st-files">
                    {files.map((f, k) => (
                      <div key={f.name + k} className="st-file">
                        <span className="st-fname">{f.name}</span>
                        <select value={f.role} onChange={(e) => setFiles((fs) => fs.map((x, i) => (i === k ? { ...x, role: e.target.value as FileRole } : x)))}>
                          <option value="prep">prep arch</option>
                          <option value="antagonist">antagonist</option>
                          <option value="bite">bite (unused)</option>
                          <option value="crown">crown (reference)</option>
                          <option value="ignore">ignore</option>
                        </select>
                      </div>
                    ))}
                    <button className="st-primary" onClick={() => void commitScans(files, tooth)}>Use these scans</button>
                  </div>
                )}
                {ai.needsCode && (
                  <label className="st-field">
                    <span>AI access code</span>
                    <input value={code} onChange={(e) => { setCode(e.target.value); setAccessCode(e.target.value) }} placeholder="from your lab admin" />
                  </label>
                )}
                <p className="st-fine">
                  AI features (free-form requests, Rx photos, AI review) send the design data, renders and photos to Claude{ai.mode === 'artifact' ? ' on your Claude account' : ' through Anthropic’s API'}. Keep patient identifiers out of photos unless your lab has a BAA covering it. Scans never leave the device — the design engine runs on it.
                </p>
              </div>
            )}

            {step === 'margin' && (
              <div className="st-stack">
                {!loaded && <p>Load the scans first.</p>}
                {loaded && !margin && <p className="st-big">Tap the top of the prepared tooth.</p>}
                {margin && (
                  <>
                    <p>
                      Margin: {margin.points.length} samples, {Math.round(100 * (1 - margin.confidence.filter((c) => c < 0.35).length / margin.confidence.length))}% high-confidence (green). Red sections are where the finish line was unclear.
                    </p>
                    <div className="st-row">
                      <button className={editMargin ? 'st-primary' : 'st-secondary'} onClick={() => setEditMargin((e) => !e)}>{editMargin ? 'Done fixing' : 'Fix margin'}</button>
                      <button className="st-secondary" onClick={() => { pushHistory(); setMargin(null); setDesign(null); viewRef.current?.setMargin(null); viewRef.current?.setCrown(null) }}>Re-tap prep</button>
                      <button className="st-secondary" onClick={() => void execute({ kind: 'flipBuccal' })}>Flip buccal</button>
                    </div>
                    {editMargin && <p className="st-fine">Tap on the scan where the margin should be — the nearest part of the line moves there and the crown redesigns.</p>}
                    <Slider label="Axis tilt mesial/distal" unit="°" min={-15} max={15} step={1} value={params.axisTiltMesialDeg} onChange={(v) => slide('axisTiltMesialDeg', v)} hint="+ mesial" />
                    <Slider label="Axis tilt buccal/lingual" unit="°" min={-15} max={15} step={1} value={params.axisTiltBuccalDeg} onChange={(v) => slide('axisTiltBuccalDeg', v)} hint="+ buccal" />
                    {design && (
                      <p className="st-fine">
                        Undercuts along this path: {design.results.find((r) => r.id === 'undercut')?.measured ?? '—'}
                      </p>
                    )}
                    {design && <p className="st-fine">Buccal arrow (B) {Math.round(design.buccalConfidence * 100)}% confident — it should point to the cheek.</p>}
                  </>
                )}
              </div>
            )}

            {step === 'design' && (
              <div className="st-stack">
                {!d && <p>{margin ? 'Designing…' : 'Tap the prep on the Margin step first.'}</p>}
                {d && (
                  <>
                    <div className="st-anat">
                      Anatomy: {model && useLearned ? `learned — ${model.source}` : 'textbook template'}
                      {model && (
                        <button className="st-link" onClick={() => { setUseLearned((u) => !u); setTimeout(() => void runDesign('final'), 0) }}>
                          {useLearned ? 'use textbook' : 'use learned'}
                        </button>
                      )}
                    </div>
                    {sculptAt ? (
                      <div className="st-sculpt">
                        <span>Spot selected</span>
                        <button onClick={() => void sculptHere(-0.1)}>−0.1</button>
                        <button onClick={() => void sculptHere(-0.05)}>−0.05</button>
                        <button onClick={() => void sculptHere(0.05)}>+0.05</button>
                        <button onClick={() => void sculptHere(0.1)}>+0.1</button>
                        <select value={sculptRadius} onChange={(e) => { setSculptRadius(Number(e.target.value)); viewRef.current?.setMarker(sculptAt.point, Number(e.target.value)) }}>
                          {[0.8, 1.5, 2.5].map((r) => (
                            <option key={r} value={r}>r {r} mm</option>
                          ))}
                        </select>
                        <button className="st-link" onClick={() => { setSculptAt(null); viewRef.current?.setMarker(null) }}>✕</button>
                      </div>
                    ) : (
                      <p className="st-fine">Tap the crown to add or remove material at a spot.</p>
                    )}
                    <Slider label="Mesial contact" unit="mm" min={-0.1} max={0.15} step={0.01} value={params.contactMesialMm} onChange={(v) => slide('contactMesialMm', v)} hint="− tighter" />
                    <Slider label="Distal contact" unit="mm" min={-0.1} max={0.15} step={0.01} value={params.contactDistalMm} onChange={(v) => slide('contactDistalMm', v)} hint="− tighter" />
                    <Slider label="Occlusal clearance" unit="mm" min={0} max={0.3} step={0.01} value={params.occlusalClearanceMm} onChange={(v) => slide('occlusalClearanceMm', v)} hint="+ lower" />
                    <Slider label="Cusp height" unit="×" min={0.6} max={1.4} step={0.05} value={params.cuspScale} onChange={(v) => slide('cuspScale', v)} />
                    <Slider label="Buccal contour" unit="mm" min={-0.4} max={0.6} step={0.05} value={params.buccalBulgeMm} onChange={(v) => slide('buccalBulgeMm', v)} />
                    <Slider label="Lingual contour" unit="mm" min={-0.4} max={0.6} step={0.05} value={params.lingualBulgeMm} onChange={(v) => slide('lingualBulgeMm', v)} />
                    <Slider label="Rotation" unit="°" min={-15} max={15} step={1} value={params.rotationDeg} onChange={(v) => slide('rotationDeg', v)} />
                    <div className="st-row">
                      <button className="st-secondary" onClick={() => void execute({ kind: 'undo' })}>Undo</button>
                      <button className="st-secondary" onClick={() => void execute({ kind: 'redo' })}>Redo</button>
                      <button className="st-secondary" onClick={() => void redesignWith({ params: { ...DEFAULT_PARAMS, material: params.material } }, 'Reset to defaults')}>Reset</button>
                    </div>
                    <p className="st-fine">
                      Space M {fmt(d.measures.spaceMesialMm)} / D {fmt(d.measures.spaceDistalMm)} mm · crown {fmt(d.measures.mdWidthMm, 1)} × {fmt(d.measures.blWidthMm, 1)} mm · {fmt(d.volumeMm3, 0)} mm³ · {Object.values(d.timingsMs).reduce((a, b) => a + b, 0)} ms
                    </p>
                  </>
                )}
              </div>
            )}

            {step === 'check' && (
              <div className="st-stack">
                {!d && <p>No design yet.</p>}
                {d && (
                  <>
                    <ul className="st-checks">
                      {d.results.map((r) => (
                        <li key={r.id} className={r.verdict}>
                          <span className="st-v">{r.verdict === 'pass' ? '✓' : r.verdict === 'warn' ? '!' : '✕'}</span>
                          <div>
                            <b>{r.label}</b> <span className="st-m">{r.measured}</span>
                            <div className="st-fine">{r.message}{r.fix ? ` ${r.fix}` : ''}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="st-row">
                      <button className="st-secondary" onClick={() => setLayerState('heatmap')}>{viewRef.current?.heatmapOn ? 'Hide' : 'Show'} thickness map</button>
                      <button className="st-primary" onClick={() => void runReview()} disabled={!ai.ai}>AI review</button>
                    </div>
                    {review && <div className="st-review">{review}</div>}
                  </>
                )}
              </div>
            )}

            {step === 'export' && (
              <div className="st-stack">
                {!d && <p>No design yet.</p>}
                {d && (
                  <>
                    {!d.exportable && (
                      <div className="st-warnbox">
                        <b>Checks failing:</b> {d.results.filter((r) => r.verdict === 'fail').map((r) => `${r.label} (${r.measured})`).join(', ')}.
                        <label className="st-field">
                          <span>Export anyway — reason (saved with the design)</span>
                          <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="e.g. doctor approved reduced occlusal thickness" />
                        </label>
                      </div>
                    )}
                    <label className="st-check">
                      <input type="checkbox" checked={alignZ} onChange={(e) => setAlignZ(e.target.checked)} /> Align insertion axis to +Z (for CAM)
                    </label>
                    <div className="st-row">
                      <button className="st-primary" disabled={!d.exportable && override.trim().length < 5} onClick={() => void exportCrown(false)}>Download STL</button>
                      {!downloadsRef.current && <button className="st-secondary" disabled={!d.exportable && override.trim().length < 5} onClick={() => void exportCrown(true)}>Share…</button>}
                    </div>
                    <p className="st-fine">Exports a closed, single-solid STL (watertight-checked) plus a .design.json with the margin, parameters and check results, so the design can be audited or reproduced{downloadsRef.current ? ' — bundled as one .zip here' : ''}.</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <footer className="st-cmd">
        <form onSubmit={(e) => { e.preventDefault(); void submit(input) }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={framed ? 'Type or use your keyboard mic — “tighter mesial contact”' : ai.ai ? 'Say or type anything — “tighter mesial contact”' : 'Try “tighter mesial contact”, “flatter cusps”…'} aria-label="Command" enterKeyHint="send" />
          {dictation?.supported && !framed && (
            <button type="button" className={listening ? 'st-mic on' : 'st-mic'} onClick={() => (listening ? dictation.stop() : dictation.start())} aria-label="Speak">
              {listening ? '◼' : '🎙'}
            </button>
          )}
          <button type="submit" className="st-send" aria-label="Send">➤</button>
        </form>
        <p className="st-status" role="status">{chat.length ? `${chat[chat.length - 1].who === 'ai' ? 'AI: ' : ''}${chat[chat.length - 1].text}` : status}</p>
      </footer>

      <input ref={fileRef} type="file" accept=".stl,.ply" multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = '' }} />
      <input ref={libRef} type="file" accept=".stl,.ply" multiple hidden onChange={(e) => { void importLibrary(e.target.files); e.target.value = '' }} />
      <input ref={rxRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onRxPhoto(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )

  function setLayerState(layer: 'antagonist' | 'heatmap'): void {
    viewRef.current?.setLayer(layer, 'toggle')
    setStatus(`${layer === 'heatmap' ? 'Thickness map' : 'Antagonist'} ${viewRef.current?.layerVisible(layer) ? 'on' : 'off'}.`)
  }
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function Slider(props: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; hint?: string }): React.JSX.Element {
  return (
    <label className="st-slider">
      <span className="st-sl-label">
        {props.label} <b>{props.value.toFixed(props.step < 0.1 ? 2 : props.step < 1 ? 1 : 0)}</b>
        {props.unit} {props.hint && <i>{props.hint}</i>}
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  )
}
