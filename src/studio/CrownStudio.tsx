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
import { parseGeometry, parseScan, exportSTL } from '../core/meshConvert'
import { parseEoff } from '../crown/eoff'
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
import NewCase, { type NewCaseResult } from './NewCase'
import ReviewDeck, { type AdjustTarget } from './ReviewDeck'
import { CONTRACT, validateJob, type CrownJob, type CrownOutcome, type QcDecision } from '../module/contract'
import { assembleOutcome } from '../module/designCase'
import { embedHost, toHost } from '../module/embed'
import { fdiToUniversal } from '../crown/library'
import './studio.css'

/**
 * The stages mirror the exocad crown wizard (margin → insertion axis →
 * library tooth → adaptation/free-forming → checks → export) so a
 * technician finds every decision where they expect it — but each stage is
 * done for them on the first pass and only revisited to override.
 */
type Step = 'case' | 'margin' | 'axis' | 'anatomy' | 'design' | 'check' | 'export'
const STEPS: Array<[Step, string]> = [
  ['case', 'Scans'],
  ['margin', 'Margin'],
  ['axis', 'Axis'],
  ['anatomy', 'Anatomy'],
  ['design', 'Adapt'],
  ['check', 'Check'],
  ['export', 'Export']
]

type Detent = 'peek' | 'half' | 'full'

interface RunStage {
  key: string
  label: string
  status: 'pending' | 'active' | 'done' | 'warn' | 'fail' | 'skipped'
  detail?: string
}

/** Parameters + margin, rounded — equal keys mean the technician changed nothing. */
const designKey = (d: DesignData): string => JSON.stringify({ p: d.params, m: d.margin.points.map((q) => q.map((x) => Math.round(x * 100))) })

/** Set when the studio runs inside a host app (the suite): `?embed=1&host=<origin>`. */
const EMBED_HOST = typeof location !== 'undefined' ? embedHost() : null

const TOOTH_NAMES: Record<string, string> = {
  upperMolar: 'upper molar',
  lowerMolar: 'lower molar',
  upperPremolar: 'upper premolar',
  lowerPremolar: 'lower premolar',
  upperCanine: 'upper canine',
  lowerCanine: 'lower canine',
  upperAnterior: 'upper incisor',
  lowerAnterior: 'lower incisor'
}

function haptic(ms = 8): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* not supported */
  }
}

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

type CriticResultLite = DesignData['results'][number]

const fmt = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))

export default function CrownStudio(): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<StudioViewport | null>(null)
  const engineRef = useRef<CrownEngine | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rxRef = useRef<HTMLInputElement>(null)
  const libRef = useRef<HTMLInputElement>(null)
  const [libNote, setLibNote] = useState<string | null>(null)
  const [libJaw, setLibJaw] = useState<'auto' | 'upper' | 'lower'>('auto')
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
  const [detent, setDetent] = useState<Detent>('peek')
  const [run, setRun] = useState<RunStage[] | null>(null)
  const [appearance, setAppearanceState] = useState<'dark' | 'light' | 'system'>(() => {
    try {
      const a = localStorage.getItem('saycad.appearance')
      return a === 'light' || a === 'system' ? a : 'dark'
    } catch {
      return 'dark'
    }
  })
  const systemDark = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  const [dark, setDark] = useState(() => appearance === 'dark' || (appearance === 'system' && systemDark()))
  const setAppearance = (a: 'dark' | 'light' | 'system'): void => {
    setAppearanceState(a)
    setDark(a === 'dark' || (a === 'system' && systemDark()))
    try {
      localStorage.setItem('saycad.appearance', a)
    } catch {
      /* storage unavailable */
    }
  }
  const [caseId, setCaseId] = useState<string | null>(null)
  const [recent, setRecent] = useState<CaseMeta[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [newCase, setNewCase] = useState(false)
  const [asking, setAsking] = useState<string | null>(null) // what the coach banner asks for, when not the default
  const [library, setLibraryState] = useState<'round' | 'rectangular'>(() => {
    try {
      return localStorage.getItem('saycad.library') === 'rectangular' ? 'rectangular' : 'round'
    } catch {
      return 'round'
    }
  })
  const setLibrary = (l: 'round' | 'rectangular'): void => {
    setLibraryState(l)
    try {
      localStorage.setItem('saycad.library', l)
    } catch {
      /* storage unavailable */
    }
  }
  // Simple mode shows the AI result and one Export button; Pro mode adds the stage rail.
  const [pro, setProState] = useState(() => {
    try {
      return localStorage.getItem('saycad.pro') === '1'
    } catch {
      return false
    }
  })
  // Embedded: the job the host sent, how its prep was found, and the AI's own design (to tell edits apart).
  const jobRef = useRef<{ job: CrownJob; prepFoundBy?: CrownOutcome['prepFoundBy']; auto?: string } | null>(null)
  const setPro = (on: boolean): void => {
    setProState(on)
    try {
      localStorage.setItem('saycad.pro', on ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }

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

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => {
      if (appearance === 'system') setDark(mq.matches)
    }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [appearance])
  useEffect(() => viewRef.current?.setAppearance(dark), [dark])

  useEffect(() => viewRef.current?.setFrameVisible(step === 'margin' || step === 'axis'), [step, design])

  // Simple mode: the key measurements sit on the crown itself.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    if (pro || step !== 'check' || !design) return v.setCallouts([])
    const f = design.frame
    const p = design.crown.positions
    let mes = -Infinity, dis = Infinity, top = -Infinity
    let pm: [number, number, number] = [0, 0, 0], pd = pm, pt = pm
    for (let k = 0; k < p.length; k += 3) {
      const q: [number, number, number] = [p[k] - f.origin[0], p[k + 1] - f.origin[1], p[k + 2] - f.origin[2]]
      const m = q[0] * f.mesial[0] + q[1] * f.mesial[1] + q[2] * f.mesial[2]
      const o = q[0] * f.occlusal[0] + q[1] * f.occlusal[1] + q[2] * f.occlusal[2]
      const at: [number, number, number] = [p[k], p[k + 1], p[k + 2]]
      if (m > mes) [mes, pm] = [m, at]
      if (m < dis) [dis, pd] = [m, at]
      if (o > top) [top, pt] = [o, at]
    }
    const s = design.summary
    v.setCallouts([
      { point: pm, text: `M ${fmt(s.mesialContactMm)}` },
      { point: pd, text: `D ${fmt(s.distalContactMm)}` },
      { point: pt, text: `occl ${fmt(s.occlusalMinMm)} mm` }
    ])
  }, [pro, step, design])

  // Embedded in the suite: accept jobs from the host origin only.
  useEffect(() => {
    if (!EMBED_HOST) return
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== EMBED_HOST) return
      const m = e.data as { contract?: string; type?: string; job?: CrownJob }
      if (m?.contract === CONTRACT && m.type === 'crown:open' && m.job) void openJob(m.job)
    }
    window.addEventListener('message', onMessage)
    toHost(EMBED_HOST, { contract: CONTRACT, type: 'crown:ready' })
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the model centred above the sheet as it changes height.
  const sheetRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const measure = (): void => {
      const sheet = sheetRef.current?.getBoundingClientRect()
      const rail = (document.querySelector('.st-rail') ?? document.querySelector('.st-nav'))?.getBoundingClientRect()
      if (!sheet) return
      viewRef.current?.setObscured(rail ? rail.bottom : 0, window.innerHeight - sheet.top)
    }
    measure()
    // Measure again once the detent animation has finished, however long it took.
    const el = sheetRef.current
    el?.addEventListener('transitionend', measure)
    const ro = el ? new ResizeObserver(measure) : null
    if (el) ro!.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      el?.removeEventListener('transitionend', measure)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [detent, loaded])

  // Anatomy for this tooth: a model the lab trained or imported on this device,
  // else the bundled library's own tooth for this position (Round or
  // Rectangular), else a class model, else the textbook template. Designs wait
  // for it (modelReady) so the first design never starts on the wrong shape.
  const modelReady = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    let cancelled = false
    let done: () => void = () => {}
    modelReady.current = new Promise<void>((r) => (done = r))
    const cls = toothClassOf(tooth)
    const parse = (txt: string | null): { json: string; count: number; source: string } | null => {
      if (!txt || !txt.trim().startsWith('{')) return null
      try {
        const m = JSON.parse(txt) as { count: number; source?: string }
        return { json: txt, count: m.count, source: m.source ?? `${m.count} cases` }
      } catch {
        return null
      }
    }
    const get = (path: string): Promise<string | null> =>
      fetch(`${import.meta.env.BASE_URL}models/${path}`)
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null)
    void (async () => {
      const found = parse(await loadModel(cls)) ?? parse(await get(`lib-${library}-t${tooth}.json`)) ?? parse(await get(`ssm-${cls}.json`))
      if (cancelled) return
      setModel(found)
      state.current.model = found
      done()
      // A design already on screen follows the new anatomy.
      if (state.current.design && state.current.margin) void runDesign('final')
    })()
    return () => {
      cancelled = true
      done()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooth, modelsVersion, library])

  /** Resolves once this tooth's anatomy has loaded (or after 5 s, whichever is first). */
  const waitModel = (): Promise<void> => Promise.race([modelReady.current, new Promise<void>((r) => setTimeout(r, 5000))])

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

  async function commitScans(list: ScanFile[], t: number, restore?: CaseMeta, info?: { name: string; order?: CaseMeta['order'] }): Promise<void> {
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
      setDetent('peek') // keep the model clear for the tap
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
        const stem = list[0]?.name.replace(/\.(stl|ply|obj)$/i, '').slice(0, 28) ?? 'case'
        const ok = await saveCase(
          { id, name: info?.name ?? `#${t} · ${stem}`, tooth: t, createdAt: now, updatedAt: now, order: info?.order },
          list.filter((f) => f.role === 'prep' || f.role === 'antagonist' || f.role === 'bite' || f.role === 'preop').map((f) => {
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
    const scansPicked = Array.from(list ?? []).filter((f) => /\.(stl|ply|obj)$/i.test(f.name))
    if (!scansPicked.length) {
      if (list?.length) setStatus('Pick STL or PLY scan files (or use New Case for a .zip export).')
      return
    }
    setBusy('Reading files…')
    const parsed: ScanFile[] = []
    const names = scansPicked.map((f) => f.name)
    const t = toothFromNames(names) ?? tooth
    const roles = assignRoles(names, { toothNumber: t })
    for (const f of scansPicked) {
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

  /** Finds the prep from the bite and designs straight away; falls back to asking for a tap. */
  async function autoFind(): Promise<void> {
    setBusy('Finding the prepared tooth…')
    let guess
    try {
      guess = await engineRef.current!.findPrep()
    } catch (e) {
      guess = { point: null, reason: e instanceof Error ? e.message : String(e) }
    } finally {
      setBusy(null)
    }
    if (!guess.point) {
      setStatus(guess.reason ?? 'Tap the prepared tooth.')
      // Real arches often have several teeth out of contact: offer the likely
      // ones as numbered pins — one tap picks the prep.
      const cands = ('candidates' in guess ? guess.candidates : undefined) ?? []
      if (cands.length > 1) {
        say('app', `Several teeth are out of the bite. Tap the number on #${state.current.tooth} — or tap the tooth itself.`)
        setAsking(`Tap the number on #${state.current.tooth}`)
        viewRef.current?.view('fit')
        viewRef.current?.setPins(
          cands.slice(0, 5).map((c, k) => ({
            point: c.point,
            label: String(k + 1),
            aria: `Candidate prep ${k + 1}`,
            onTap: () => {
              viewRef.current?.setPins([])
              if (jobRef.current) jobRef.current.prepFoundBy = 'host'
              void tapPrep(c.point, guess.ups)
            }
          }))
        )
      }
      const j = jobRef.current
      if (EMBED_HOST && j) toHost(EMBED_HOST, { contract: CONTRACT, type: 'crown:outcome', outcome: { contract: CONTRACT, jobId: j.job.jobId, caseRef: j.job.order.caseRef, status: 'needs-input', needs: [{ kind: 'prep-location', message: `${guess.reason ?? ''} The technician can tap it in the studio.`.trim() }], engine: { contract: CONTRACT, version: '' } } })
      return
    }
    say('app', `Found the prep on #${state.current.tooth} from the bite.`)
    if (jobRef.current) jobRef.current.prepFoundBy = 'bite'
    await tapPrep(guess.point, guess.ups)
  }

  /** The current design as a saycad.crown/1 outcome (embedded mode). */
  function outcomeNow(design?: DesignData | null): CrownOutcome | null {
    const s = state.current
    // Just after a design the ref may predate the re-render: prefer the design handed in.
    const d = design ?? s.design
    const j = jobRef.current
    if (!d || !j || !d.crown.indices) return null
    return assembleOutcome({
      job: j.job,
      tooth: s.tooth,
      results: d.results,
      summary: d.summary,
      volumeMm3: d.volumeMm3,
      margin: d.margin,
      params: d.params,
      frame: d.frame,
      positions: d.crown.positions,
      indices: d.crown.indices,
      prepFoundBy: j.prepFoundBy,
      anatomy: s.useLearned && s.model ? `library — ${s.model.source}` : 'textbook — no library tooth for this position',
      intake: []
    })
  }

  /** A job from the host: load its scans and run the automated design. */
  async function openJob(job: CrownJob): Promise<void> {
    const problems = validateJob(job)
    if (problems.length) {
      toHost(EMBED_HOST!, { contract: CONTRACT, type: 'crown:outcome', outcome: { contract: CONTRACT, jobId: job?.jobId ?? '', status: 'failed', error: problems.join(' '), engine: { contract: CONTRACT, version: '' } } })
      setStatus(problems.join(' '))
      return
    }
    const t = job.order.system === 'fdi' ? fdiToUniversal(job.order.tooth)! : job.order.tooth
    const geo = (sc: CrownJob['scans']['prep']): THREE.BufferGeometry => {
      if ('mesh' in sc) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(sc.mesh.positions, 3))
        if (sc.mesh.indices) g.setIndex(new THREE.BufferAttribute(sc.mesh.indices, 1))
        return g
      }
      return parseScan(sc.name, sc.data)
    }
    const list: ScanFile[] = [{ name: job.scans.prep.name, role: 'prep', geometry: geo(job.scans.prep) }]
    if (job.scans.antagonist) list.push({ name: job.scans.antagonist.name, role: 'antagonist', geometry: geo(job.scans.antagonist) })
    for (const b of job.scans.bite ?? []) list.push({ name: b.name, role: 'bite', geometry: geo(b) })
    if (job.scans.preop) list.push({ name: job.scans.preop.name, role: 'preop', geometry: geo(job.scans.preop) })
    jobRef.current = { job }
    const material = job.order.material ?? 'zirconia-hs'
    setTooth(t)
    setParams((p) => ({ ...p, ...job.options?.params, material, cementGapMm: undefined }))
    state.current.params = { ...state.current.params, ...job.options?.params, material, cementGapMm: undefined }
    setFiles(list)
    await commitScans(list, t, undefined, { name: `${job.order.caseRef ?? job.jobId} · #${t}` })
    say('app', `Case from the suite: #${t}${job.order.caseRef ? ` (${job.order.caseRef})` : ''}.`)
    if (job.options?.tap) {
      jobRef.current.prepFoundBy = 'host'
      await tapPrep(job.options.tap)
    } else if (job.scans.antagonist) await autoFind()
  }

  /** The technician's decision → the host, with the crown as approved. */
  function sendQc(decision: QcDecision['decision']): void {
    const j = jobRef.current
    if (!EMBED_HOST || !j) return
    const outcome = decision === 'rejected' ? undefined : outcomeNow() ?? undefined
    const d = state.current.design
    const edited = decision !== 'rejected' && d ? designKey(d) !== j.auto : false
    const qc: QcDecision = {
      contract: CONTRACT,
      jobId: j.job.jobId,
      decision: decision === 'approved' && edited ? 'edited' : decision,
      at: new Date().toISOString(),
      reason: decision === 'rejected' ? 'Sent back by the technician.' : state.current.design && !state.current.design.exportable ? override || undefined : undefined,
      edits: edited && d ? { params: d.params, margin: d.margin.points } : undefined
    }
    toHost(EMBED_HOST, { contract: CONTRACT, type: 'crown:qc', decision: qc, outcome }, outcome?.files ? [outcome.files.crownStl] : [])
    haptic(15)
    setStatus(qc.decision === 'rejected' ? 'Sent back to the suite.' : `Sent to the suite (${qc.decision}).`)
  }

  /** Scans and order from the New Case deck → the designer. */
  async function startCase(r: NewCaseResult): Promise<void> {
    setNewCase(false)
    const t = r.order.tooth!
    const list: ScanFile[] = r.scans.map((sc) => ({ name: sc.name, role: sc.slot, geometry: sc.geometry }))
    setTooth(t)
    setParams((p) => ({ ...p, material: r.order.material, cementGapMm: undefined }))
    state.current.params = { ...state.current.params, material: r.order.material, cementGapMm: undefined }
    setFiles(list)
    const who = r.order.patient.trim()
    await commitScans(list, t, undefined, { name: `${who ? `${who.slice(0, 28)} · ` : ''}#${t}`, order: r.order })
    say('app', `Case started: #${t}, ${MATERIALS[r.order.material].label}, shade ${r.order.shade}${r.order.doctor ? `, for ${r.order.doctor}` : ''}.`)
    if (list.some((f) => f.role === 'antagonist')) await autoFind()
  }

  async function importLibrary(list: FileList | null): Promise<void> {
    if (!list || !list.length) return
    const picked = Array.from(list).filter((f) => /\.(stl|ply|obj|eoff)$/i.test(f.name)) // the input is cleared right after this call
    setBusy(`Reading ${picked.length} library file(s)…`)
    try {
      const files: Array<{ name: string; mesh: MeshData }> = []
      for (const f of picked) {
        try {
          const g = /\.eoff$/i.test(f.name) ? parseEoff(await f.arrayBuffer()) : await parseGeometry(f)
          files.push({ name: f.name, mesh: meshData(g) })
        } catch {
          /* unreadable file: reported as skipped below */
        }
      }
      setBusy('Learning the library’s tooth forms…')
      const r = await engineRef.current!.importLibrary(files, 'auto', 'imported library', libJaw === 'auto' ? undefined : libJaw)
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

  /** Marks one stage of the design run (the card the sheet shows). */
  function stage(key: string, status: RunStage['status'], detail?: string): void {
    setRun((r) => (r ? r.map((x) => (x.key === key ? { ...x, status, detail: detail ?? x.detail } : x)) : r))
  }

  /**
   * The end-to-end AI crown: one tap on the prep runs every wizard stage in
   * order, shows each result as it lands, lets Claude try to clear anything
   * failing, has Claude review the result, and stops on the checks — the
   * technician's decision point.
   */
  async function tapPrep(point: [number, number, number], ups?: Array<[number, number, number]>): Promise<void> {
    viewRef.current?.setPins([])
    setAsking(null)
    await waitModel()
    const withAi = ai.ai
    setRun([
      { key: 'margin', label: 'Margin line', status: 'active' },
      { key: 'axis', label: 'Insertion axis', status: 'pending' },
      { key: 'anatomy', label: 'Anatomy', status: 'pending' },
      { key: 'adapt', label: 'Contacts & occlusion', status: 'pending' },
      { key: 'thickness', label: 'Material thickness', status: 'pending' },
      { key: 'checks', label: 'Quality checks', status: 'pending' },
      { key: 'ai', label: 'AI review', status: withAi ? 'pending' : 'skipped', detail: withAi ? undefined : 'AI not connected' }
    ])
    setStep('margin')
    setDetent('half')
    setBusy('Finding the margin…')
    let m: MarginResult
    try {
      m = await engineRef.current!.margin(point, ups)
    } catch (e) {
      stage('margin', 'fail', e instanceof Error ? e.message : String(e))
      setStatus(e instanceof Error ? e.message : String(e))
      setBusy(null)
      return
    }
    pushHistory()
    setMargin(m)
    viewRef.current?.setMargin(m.points, m.confidence)
    const sure = Math.round(100 * (1 - m.confidence.filter((c) => c < 0.35).length / m.confidence.length))
    stage('margin', sure >= 85 ? 'done' : 'warn', `${sure}% clear finish line`)
    stage('axis', 'active')
    const d = await runDesign('final', { margin: m })
    if (!d) {
      stage('axis', 'fail', 'design failed')
      return
    }
    haptic()
    const r = (id: string): CriticResultLite | undefined => d.results.find((x) => x.id === id)
    const v = (x?: CriticResultLite): RunStage['status'] => (!x ? 'done' : x.verdict === 'pass' ? 'done' : x.verdict === 'warn' ? 'warn' : 'fail')
    stage('axis', v(r('undercut')), r('undercut')?.measured.split(',')[0] ?? 'set')
    stage('anatomy', state.current.useLearned && state.current.model ? 'done' : 'warn', state.current.useLearned && state.current.model ? state.current.model.source : 'textbook — no library tooth for this position')
    const contactWorst = [r('contact-mesial'), r('contact-distal'), r('occlusion')].sort((a, b) => rank(b) - rank(a))[0]
    stage('adapt', v(contactWorst), `M ${fmt(d.summary.mesialContactMm)} · D ${fmt(d.summary.distalContactMm)} · occl ${fmt(d.summary.occlusalMinMm)} mm`)
    const thickWorst = [r('thickness-axial'), r('thickness-occlusal')].sort((a, b) => rank(b) - rank(a))[0]
    stage('thickness', v(thickWorst), `${fmt(d.summary.minAxialThicknessMm)} axial · ${fmt(d.summary.minOcclusalThicknessMm)} occlusal mm`)
    const passes = d.results.filter((x) => x.verdict === 'pass').length
    let final = d
    stage('checks', d.exportable ? (passes === d.results.length ? 'done' : 'warn') : 'fail', `${passes}/${d.results.length} pass`)
    if (withAi) {
      if (!d.exportable) {
        stage('checks', 'active', 'asking Claude to fix…')
        await fixWithAi()
        final = state.current.design ?? d
        const p2 = final.results.filter((x) => x.verdict === 'pass').length
        stage('checks', final.exportable ? 'done' : 'fail', `${p2}/${final.results.length} pass${final.exportable ? ' after AI fix' : ''}`)
      }
      stage('ai', 'active')
      await runReview()
      stage('ai', 'done', 'see below')
    }
    setStep('check')
    viewRef.current?.view('buccal')
    setStatus(final.exportable ? 'Crown designed and checked — ready to export.' : 'Crown designed — some checks need you. See Check.')
    const j = jobRef.current
    if (EMBED_HOST && j) {
      j.prepFoundBy ??= 'host' // tapped in the studio
      const o = outcomeNow(final)
      j.auto = designKey(final)
      if (o) toHost(EMBED_HOST, { contract: CONTRACT, type: 'crown:outcome', outcome: o }, [o.files!.crownStl])
    }
  }

  function rank(x?: CriticResultLite): number {
    return !x ? 0 : x.verdict === 'fail' ? 2 : x.verdict === 'warn' ? 1 : 0
  }

  /** Lets Claude clear failing checks through the normal tools. */
  async function fixWithAi(): Promise<void> {
    const prompt = 'Some quality checks are failing or flagged. Change design parameters to clear them where a parameter can (call get_checks after each change). If the prep or scan itself prevents it, do not force it: say in one sentence what the dentist or technician has to change.'
    try {
      const r =
        ai.mode === 'artifact' && sampleRef.current
          ? await assistViaSample(sampleRef.current, sampleChat.current, prompt, stateSummary(), execute)
          : await assist(aiHistory.current, prompt, stateSummary(), execute)
      say('ai', r.reply)
    } catch (e) {
      say('app', ai.mode === 'artifact' ? sampleErrorText(e) : e instanceof Error ? e.message : String(e))
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
      if (detent === 'peek') setDetent('half')
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
  const stepIndex = STEPS.findIndex(([k]) => k === step)
  const stageState = (k: Step): 'done' | 'current' | 'todo' | 'attention' => {
    if (k === step) return 'current'
    const reached = k === 'case' ? loaded : k === 'margin' ? Boolean(margin) : Boolean(d)
    if (!reached) return 'todo'
    if (k === 'check' && counts && counts.fail) return 'attention'
    return 'done'
  }
  const next = (): void => {
    const n = STEPS[Math.min(STEPS.length - 1, stepIndex + 1)][0]
    setStep(n)
    haptic()
  }
  const lastLine = chat.length ? `${chat[chat.length - 1].who === 'ai' ? 'AI · ' : ''}${chat[chat.length - 1].text}` : status
  const toothLabel = `#${tooth} · ${TOOTH_NAMES[toothClassOf(tooth)] ?? ''}`

  return (
    <div className={`studio ${dark ? 'dark' : ''}`}>
      <div className="st-stage" ref={mountRef}>
        {!loaded && !busy && EMBED_HOST && (
          <div className="st-welcome">
            <p className="st-eyebrow">{LAB_NAME} · Crowns</p>
            <h1>Waiting for the case…</h1>
            <p>The suite sends the order and scans; the crown is designed as soon as they arrive.</p>
          </div>
        )}
        {!loaded && !busy && !EMBED_HOST && (
          <div className="st-welcome">
            <p className="st-eyebrow">{LAB_NAME} · Crowns</p>
            <h1>AI crowns from two scans.</h1>
            <p>Pick the tooth, add the prep and opposing scans. The prep is found from the bite, and the crown is margined, shaped from the tooth library, fitted and checked.</p>
            <div className="st-welcome-actions">
              <button className="st-btn primary large" onClick={() => setNewCase(true)}>New Crown</button>
              <button className="st-btn tinted large" onClick={() => void loadDemo(true)}>Try the Demo Case</button>
            </div>
            {recent.length > 0 && (
              <div className="st-group st-welcome-recents">
                <div className="st-group-head">Recent</div>
                {recent.slice(0, 3).map((c) => (
                  <div key={c.id} className="st-row-item">
                    <button className="st-row-main st-row-btn" onClick={() => void openCase(c.id)}>
                      <b>{c.name}</b>
                      <span>{new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{c.status ? ` · ${c.status}` : ''}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {loaded && !margin && !busy && <div className="st-coach">{asking ?? 'Tap the prepared tooth'}</div>}
        {(listening || interim) && <div className="st-coach live">{interim || 'Listening…'}</div>}
        {busy && (
          <div className="st-hud" role="status">
            <span className="st-spinner" /> {busy}
          </div>
        )}
        {loaded && (
          <div className="st-viewbar" role="toolbar" aria-label="Views">
            {(['occlusal', 'buccal', 'lingual', 'mesial', 'distal'] as const).map((v) => (
              <button key={v} onClick={() => viewRef.current?.view(v)} title={`${v[0].toUpperCase()}${v.slice(1)} view`} aria-label={`${v} view`}>
                {v[0].toUpperCase()}
              </button>
            ))}
            <span className="st-viewbar-sep" />
            <button onClick={() => setLayerState('antagonist')} title="Show or hide the opposing jaw" aria-label="Opposing jaw">◐</button>
            <button onClick={() => setLayerState('heatmap')} title="Thickness map" aria-label="Thickness map">▤</button>
          </div>
        )}
      </div>

      <header className="st-nav">
        <button className="st-nav-title" onClick={() => { setStep('case'); setDetent('half') }}>
          <span className="st-nav-case">{loaded ? toothLabel : 'New case'}</span>
          <span className="st-nav-sub">{MATERIALS[params.material].label}</span>
        </button>
        <span className="st-flex" />
        {counts && (
          <button className={`st-pill ${counts.fail ? 'bad' : counts.warn ? 'meh' : 'good'}`} onClick={() => setStep('check')}>
            {counts.fail ? `${counts.fail} Issue${counts.fail > 1 ? 's' : ''}` : counts.warn ? `${counts.warn} to Review` : 'Ready'}
          </button>
        )}
        <span className={`st-pill ${ai.ai ? 'ai' : 'off'}`} title={ai.ai ? `Claude · ${ai.model ?? ''}` : 'AI not connected'}>
          ✦ {ai.ai ? 'AI' : 'AI Off'}
        </span>
        <button className="st-round" onClick={() => setHelpOpen((o) => !o)} aria-label="Help">?</button>
      </header>

      {loaded && pro && (
        <nav className="st-rail" aria-label="Design stages">
          {STEPS.map(([k, label]) => (
            <button key={k} className={`st-rail-item ${stageState(k)}`} onClick={() => { setStep(k); if (detent === 'peek') setDetent('half'); haptic() }} aria-current={k === step ? 'step' : undefined}>
              <span className="st-rail-dot" />
              {label}
            </button>
          ))}
        </nav>
      )}

      {helpOpen && (
        <div className="st-modal" role="dialog" aria-label="Help" onClick={() => setHelpOpen(false)}>
          <div className="st-modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>How it works</h2>
            <ol className="st-howto">
              <li>New Crown: pick the tooth, then add the prep-arch and opposing scans (STL/PLY, or the scanner's .zip).</li>
              <li>The prep is found from the bite (or tap it), and margin, axis, library anatomy, contacts, occlusion and thickness are done in one pass, then checked.</li>
              <li>Export — or Adjust Design to open every stage, or just say what you want.</li>
            </ol>
            <div className="st-group">
              <div className="st-row-item">
                <span className="st-row-main"><b>Appearance</b></span>
                <div className="st-segmented small" role="group" aria-label="Appearance">
                  {(['dark', 'light', 'system'] as const).map((a) => (
                    <button key={a} className={appearance === a ? 'on' : ''} onClick={() => setAppearance(a)}>{a[0].toUpperCase() + a.slice(1)}</button>
                  ))}
                </div>
              </div>
              <div className="st-row-item">
                <span className="st-row-main"><b>Pro tools</b><span>Show the stage rail (Margin, Axis, Anatomy, Adapt…)</span></span>
                <label className="st-switch">
                  <input type="checkbox" checked={pro} onChange={(e) => setPro(e.target.checked)} aria-label="Pro tools" />
                  <span />
                </label>
              </div>
            </div>
            <h2>Things you can say</h2>
            <dl className="st-say">
              {CROWN_HELP.map(([say2, what]) => (
                <div key={say2}>
                  <dt>“{say2}”</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
            <p className="st-foot">One finger turns the model, two fingers zoom and pan.{ai.ai ? ' Anything else you say goes to Claude, which edits with the same commands.' : ''}</p>
            <button className="st-btn primary" onClick={() => setHelpOpen(false)}>Done</button>
          </div>
        </div>
      )}

      <section ref={sheetRef} className={`st-sheet ${detent}`} aria-label="Design panel">
        <button className="st-grabber" aria-label="Resize panel" onClick={() => setDetent((x) => (x === 'peek' ? 'half' : x === 'half' ? 'full' : 'peek'))}>
          <span />
        </button>
        <form className="st-ask" onSubmit={(e) => { e.preventDefault(); void submit(input) }}>
          <span className="st-ask-icon">✦</span>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={framed ? 'Ask or type a change' : 'Ask, or say a change'} aria-label="Command" enterKeyHint="send" onFocus={() => detent === 'peek' && setDetent('half')} />
          {dictation?.supported && !framed && (
            <button type="button" className={listening ? 'st-mic on' : 'st-mic'} onClick={() => (listening ? dictation.stop() : dictation.start())} aria-label="Speak">
              {listening ? '■' : '🎙'}
            </button>
          )}
        </form>
        <p className="st-status" role="status">{lastLine}</p>

        {detent !== 'peek' && (
          <div className="st-content">
            {run && (step === 'margin' || (step === 'check' && pro)) && (
              <div className="st-group">
                <div className="st-group-head">Design run</div>
                {run.map((r) => (
                  <div key={r.key} className={`st-runrow ${r.status}`}>
                    <span className="st-runicon">{r.status === 'done' ? '✓' : r.status === 'warn' ? '!' : r.status === 'fail' ? '✕' : r.status === 'active' ? '' : '·'}</span>
                    <span className="st-runlabel">{r.label}</span>
                    <span className="st-rundetail">{r.detail ?? (r.status === 'active' ? 'working…' : '')}</span>
                  </div>
                ))}
              </div>
            )}

            {step === 'case' && (
              <>
                <h2 className="st-h">Case</h2>
                <div className="st-group">
                  <div className="st-group-head">Tooth</div>
                  <ToothChart value={tooth} onPick={(n) => void execute({ kind: 'setTooth', tooth: n })} />
                </div>
                <div className="st-group">
                  <div className="st-group-head">Material</div>
                  <div className="st-segmented wrap">
                    {Object.values(MATERIALS).map((m) => (
                      <button key={m.id} className={params.material === m.id ? 'on' : ''} onClick={() => void execute({ kind: 'material', material: m.id })}>
                        {m.label.replace(/ \(.*\)/, '')}
                      </button>
                    ))}
                  </div>
                  <p className="st-foot">{MATERIALS[params.material].label}: min {MATERIALS[params.material].minAxialMm} mm axial / {MATERIALS[params.material].minOcclusalMm} mm occlusal, cement {MATERIALS[params.material].cementGapMm} mm. {MATERIALS[params.material].note}</p>
                </div>
                <div className="st-group">
                  <div className="st-group-head">Scans</div>
                  {files.map((f, k) => (
                    <div key={f.name + k} className="st-row-item">
                      <span className="st-row-main">{f.name}</span>
                      <select aria-label={`Role of ${f.name}`} value={f.role} onChange={(e) => setFiles((fs) => fs.map((x, i) => (i === k ? { ...x, role: e.target.value as FileRole } : x)))}>
                        <option value="prep">Prep arch</option>
                        <option value="antagonist">Opposing</option>
                        <option value="bite">Bite (unused)</option>
                        <option value="crown">Crown (reference)</option>
                        <option value="ignore">Ignore</option>
                      </select>
                    </div>
                  ))}
                  <div className="st-actions">
                    <button className="st-btn tinted" onClick={() => setNewCase(true)}>New Case</button>
                    <button className="st-btn tinted" onClick={() => fileRef.current?.click()}>Add Scans</button>
                    <button className="st-btn tinted" onClick={() => void loadDemo()}>Demo Case</button>
                    <button className="st-btn tinted" onClick={() => rxRef.current?.click()} disabled={!ai.ai || !ai.images}>Read Rx Photo</button>
                  </div>
                  {rxNote && <p className="st-note">{rxNote}</p>}
                  {files.length > 0 && <button className="st-btn primary block" onClick={async () => { await commitScans(files, tooth); if (files.some((f) => f.role === 'antagonist')) await autoFind() }}>Use These Scans</button>}
                </div>
                {recent.length > 0 && (
                  <div className="st-group">
                    <div className="st-group-head">Recent cases on this device</div>
                    {recent.slice(0, 10).map((c) => (
                      <div key={c.id} className={`st-row-item ${c.id === caseId ? 'on' : ''}`}>
                        <button className="st-row-main st-row-btn" onClick={() => void openCase(c.id)}>
                          <b>{c.name}</b>
                          <span>{new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{c.status ? ` · ${c.status}` : ''}</span>
                        </button>
                        <button className="st-link danger" onClick={() => void removeCase(c.id)}>{confirmDelete === c.id ? 'Confirm' : 'Delete'}</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="st-group">
                  <div className="st-group-head">Tooth library</div>
                  <div className="st-actions">
                    <button className="st-btn tinted" onClick={() => libRef.current?.click()}>Import Library</button>
                    <select aria-label="Library jaw" value={libJaw} onChange={(e) => setLibJaw(e.target.value as 'auto' | 'upper' | 'lower')}>
                      <option value="auto">Numbers in names</option>
                      <option value="upper">Upper set (1–8)</option>
                      <option value="lower">Lower set (1–8)</option>
                    </select>
                    {model && <button className="st-link danger" onClick={() => void clearModels().then(() => { setLibNote('Imported libraries removed from this device.'); setModelsVersion((v) => v + 1) })}>Remove Imported</button>}
                  </div>
                  <p className="st-foot">STL, PLY or exocad .eoff, one file per tooth. Kept on this device.</p>
                  {libNote && <p className="st-note">{libNote}</p>}
                </div>
                {ai.needsCode && (
                  <div className="st-group">
                    <div className="st-group-head">AI access code</div>
                    <input className="st-field" value={code} onChange={(e) => { setCode(e.target.value); setAccessCode(e.target.value) }} placeholder="From your lab admin" />
                  </div>
                )}
                <p className="st-foot">Scans stay on this device; the design engine runs here. AI features send design data and renders to Claude{ai.mode === 'artifact' ? ' on your account' : ''}. Keep patient identifiers out of photos unless your agreement covers them.</p>
                {loaded && <button className="st-btn primary block" onClick={next}>Continue</button>}
              </>
            )}

            {step === 'margin' && (
              <>
                <h2 className="st-h">Margin</h2>
                {!loaded && <p className="st-lead">Load the scans first.</p>}
                {loaded && !margin && <p className="st-lead">Tap the prepared tooth. One tap finds the finish line and designs the crown.</p>}
                {margin && (
                  <>
                    <p className="st-lead">
                      {Math.round(100 * (1 - margin.confidence.filter((c) => c < 0.35).length / margin.confidence.length))}% of the line follows a clear finish line (green). Red stretches are where it was unclear — check those.
                    </p>
                    <div className="st-segmented">
                      <button className={!editMargin ? 'on' : ''} onClick={() => setEditMargin(false)}>View</button>
                      <button className={editMargin ? 'on' : ''} onClick={() => setEditMargin(true)}>Tap to Adjust</button>
                    </div>
                    {editMargin && <p className="st-foot">Tap the scan where the margin should run; the nearest stretch moves there and the crown follows.</p>}
                    <div className="st-actions">
                      <button className="st-btn tinted" onClick={() => { pushHistory(); setMargin(null); setDesign(null); setRun(null); viewRef.current?.setMargin(null); viewRef.current?.setCrown(null) }}>Redetect</button>
                      <button className="st-btn tinted" onClick={() => void execute({ kind: 'flipBuccal' })}>Flip Buccal</button>
                    </div>
                    {d && <p className="st-foot">Buccal arrow (B) {Math.round(d.buccalConfidence * 100)}% sure — it should point to the cheek.</p>}
                    <button className="st-btn primary block" onClick={next}>Continue</button>
                  </>
                )}
              </>
            )}

            {step === 'axis' && (
              <>
                <h2 className="st-h">Insertion Axis</h2>
                <p className="st-lead">Set from the margin and prep walls. Lean it only to reduce blocked-out undercuts.</p>
                <div className="st-group">
                  <Slider label="Mesial / distal" unit="°" min={-15} max={15} step={1} value={params.axisTiltMesialDeg} onChange={(v) => slide('axisTiltMesialDeg', v)} hint="+ mesial" />
                  <Slider label="Buccal / lingual" unit="°" min={-15} max={15} step={1} value={params.axisTiltBuccalDeg} onChange={(v) => slide('axisTiltBuccalDeg', v)} hint="+ buccal" />
                  <p className="st-foot">Undercut: {d?.results.find((r) => r.id === 'undercut')?.measured ?? '—'}</p>
                </div>
                <button className="st-btn primary block" onClick={next} disabled={!d}>Continue</button>
              </>
            )}

            {step === 'anatomy' && (
              <>
                <h2 className="st-h">Anatomy</h2>
                <div className="st-group">
                  <div className="st-row-item">
                    <span className="st-row-main">
                      <b>{model && useLearned ? model.source : 'Textbook template'}</b>
                      <span>{model ? 'Library tooth for this position' : 'No library for this tooth type yet'}</span>
                    </span>
                    {model && <button className="st-link" onClick={() => { setUseLearned((u) => !u); setTimeout(() => void runDesign('final'), 0) }}>{useLearned ? 'Use Textbook' : 'Use Library'}</button>}
                  </div>
                </div>
                <div className="st-group">
                  <Slider label="Cusp height" unit="×" min={0.6} max={1.4} step={0.05} value={params.cuspScale} onChange={(v) => slide('cuspScale', v)} />
                  <Slider label="Groove depth" unit="×" min={0} max={2} step={0.1} value={params.grooveScale} onChange={(v) => slide('grooveScale', v)} />
                  <Slider label="Rotation" unit="°" min={-15} max={15} step={1} value={params.rotationDeg} onChange={(v) => slide('rotationDeg', v)} />
                  <Slider label="Buccal contour" unit="mm" min={-0.4} max={0.6} step={0.05} value={params.buccalBulgeMm} onChange={(v) => slide('buccalBulgeMm', v)} />
                  <Slider label="Lingual contour" unit="mm" min={-0.4} max={0.6} step={0.05} value={params.lingualBulgeMm} onChange={(v) => slide('lingualBulgeMm', v)} />
                </div>
                <button className="st-btn primary block" onClick={next} disabled={!d}>Continue</button>
              </>
            )}

            {step === 'design' && (
              <>
                <h2 className="st-h">Adapt</h2>
                {!d && <p className="st-lead">{margin ? 'Designing…' : 'Tap the prepared tooth first.'}</p>}
                {d && (
                  <>
                    <div className="st-group">
                      <div className="st-group-head">Free-form</div>
                      {sculptAt ? (
                        <div className="st-actions">
                          <button className="st-btn tinted" onClick={() => void sculptHere(-0.1)}>− 0.1</button>
                          <button className="st-btn tinted" onClick={() => void sculptHere(-0.05)}>− 0.05</button>
                          <button className="st-btn tinted" onClick={() => void sculptHere(0.05)}>+ 0.05</button>
                          <button className="st-btn tinted" onClick={() => void sculptHere(0.1)}>+ 0.1</button>
                          <div className="st-segmented small">
                            {[0.8, 1.5, 2.5].map((r) => (
                              <button key={r} className={sculptRadius === r ? 'on' : ''} onClick={() => { setSculptRadius(r); viewRef.current?.setMarker(sculptAt.point, r) }}>{r} mm</button>
                            ))}
                          </div>
                          <button className="st-link" onClick={() => { setSculptAt(null); viewRef.current?.setMarker(null) }}>Done</button>
                        </div>
                      ) : (
                        <p className="st-foot">Tap the crown to add or remove material at a spot. Contacts, occlusion and thickness are re-checked after every edit.</p>
                      )}
                    </div>
                    <div className="st-group">
                      <div className="st-group-head">Contacts & occlusion</div>
                      <Slider label="Mesial contact" unit="mm" min={-0.1} max={0.15} step={0.01} value={params.contactMesialMm} onChange={(v) => slide('contactMesialMm', v)} hint="− tighter" />
                      <Slider label="Distal contact" unit="mm" min={-0.1} max={0.15} step={0.01} value={params.contactDistalMm} onChange={(v) => slide('contactDistalMm', v)} hint="− tighter" />
                      <Slider label="Occlusal clearance" unit="mm" min={0} max={0.3} step={0.01} value={params.occlusalClearanceMm} onChange={(v) => slide('occlusalClearanceMm', v)} hint="+ lower" />
                      <div className="st-row-item">
                        <span className="st-row-main">Occlusal stops</span>
                        <label className="st-switch">
                          <input type="checkbox" checked={params.occlusalContacts} onChange={(e) => void execute({ kind: 'occlusalContacts', on: e.target.checked })} />
                          <span />
                        </label>
                      </div>
                    </div>
                    <div className="st-actions">
                      <button className="st-btn tinted" onClick={() => void execute({ kind: 'undo' })}>Undo</button>
                      <button className="st-btn tinted" onClick={() => void execute({ kind: 'redo' })}>Redo</button>
                      <button className="st-btn tinted" onClick={() => void redesignWith({ params: { ...DEFAULT_PARAMS, material: params.material } }, 'Reset to defaults')}>Reset</button>
                    </div>
                    <p className="st-foot">
                      Space M {fmt(d.measures.spaceMesialMm)} / D {fmt(d.measures.spaceDistalMm)} mm · crown {fmt(d.measures.mdWidthMm, 1)} × {fmt(d.measures.blWidthMm, 1)} mm · {fmt(d.volumeMm3, 0)} mm³ · {Object.values(d.timingsMs).reduce((a, b) => a + b, 0)} ms
                    </p>
                    <button className="st-btn primary block" onClick={next}>Continue</button>
                  </>
                )}
              </>
            )}

            {step === 'check' && !pro && d && (
              <ReviewDeck
                design={d}
                anatomy={{ library: useLearned && !!model, label: useLearned && model ? model.source : 'textbook' }}
                library={library}
                setLibrary={setLibrary}
                ai={ai.ai}
                embedded={!!EMBED_HOST}
                onAdjust={(t: AdjustTarget) => {
                  setPro(true)
                  setStep(t)
                  setDetent('half')
                  haptic()
                }}
                onFixWithAi={async () => {
                  setBusy('Claude is fixing…')
                  await fixWithAi()
                  setBusy(null)
                }}
                onApprove={() => {
                  haptic(15)
                  if (EMBED_HOST) sendQc('approved')
                  else void exportCrown(false)
                }}
                onSendBack={EMBED_HOST ? () => sendQc('rejected') : undefined}
              />
            )}
            {step === 'check' && (pro || !d) && (
              <>
                <h2 className="st-h">Check</h2>
                {!d && <p className="st-lead">No design yet.</p>}
                {d && (
                  <>
                    <div className={`st-verdict ${counts!.fail ? 'bad' : counts!.warn ? 'meh' : 'good'}`}>
                      <b>{counts!.fail ? 'Needs attention before milling' : counts!.warn ? 'Ready — a few things to glance at' : 'Ready to mill'}</b>
                      <span>{counts!.pass} of {d.results.length} checks pass</span>
                    </div>
                    <div className="st-group">
                      {d.results.map((r) => (
                        <div key={r.id} className={`st-check ${r.verdict}`}>
                          <span className="st-check-icon">{r.verdict === 'pass' ? '✓' : r.verdict === 'warn' ? '!' : '✕'}</span>
                          <div className="st-check-body">
                            <div className="st-check-top">
                              <b>{r.label}</b>
                              <span>{r.measured}</span>
                            </div>
                            {r.verdict !== 'pass' && <p>{r.message}{r.fix ? ` ${r.fix}` : ''}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="st-legend" aria-label="Thickness colors">
                      <span><i className="c-red" /> below minimum</span>
                      <span><i className="c-amber" /> near minimum</span>
                      <span><i className="c-green" /> comfortable</span>
                      <span><i className="c-blue" /> bulky</span>
                    </div>
                    <div className="st-actions">
                      <button className="st-btn tinted" onClick={() => setLayerState('heatmap')}>{viewRef.current?.heatmapOn ? 'Hide' : 'Show'} Thickness</button>
                      <button className="st-btn tinted" onClick={() => void runReview()} disabled={!ai.ai}>AI Review</button>
                      {counts!.fail + counts!.warn > 0 && (
                        <button className="st-btn tinted" disabled={!ai.ai} onClick={async () => { setBusy('Claude is fixing…'); await fixWithAi(); setBusy(null) }}>Fix with AI</button>
                      )}
                    </div>
                    {review && <div className="st-review"><div className="st-group-head">AI review</div>{review}</div>}
                    <button className="st-btn primary block" onClick={next}>Continue to Export</button>
                  </>
                )}
              </>
            )}

            {step === 'export' && (
              <>
                <h2 className="st-h">Export</h2>
                {!d && <p className="st-lead">No design yet.</p>}
                {d && (
                  <>
                    {!d.exportable && (
                      <div className="st-verdict bad">
                        <b>Checks failing</b>
                        <span>{d.results.filter((r) => r.verdict === 'fail').map((r) => `${r.label} (${r.measured})`).join(', ')}</span>
                        <input className="st-field" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Reason to export anyway (saved with the design)" />
                      </div>
                    )}
                    <div className="st-group">
                      <div className="st-row-item">
                        <span className="st-row-main">
                          <b>{baseName()}.stl</b>
                          <span>Closed single solid · {fmt(d.volumeMm3, 0)} mm³ · {MATERIALS[params.material].label}</span>
                        </span>
                      </div>
                      <div className="st-row-item">
                        <span className="st-row-main">Insertion axis along +Z (for CAM)</span>
                        <label className="st-switch">
                          <input type="checkbox" checked={alignZ} onChange={(e) => setAlignZ(e.target.checked)} />
                          <span />
                        </label>
                      </div>
                    </div>
                    <button className="st-btn primary block" disabled={!d.exportable && override.trim().length < 5} onClick={() => { haptic(15); void exportCrown(false) }}>
                      {downloadsRef.current ? 'Download (.zip)' : 'Download STL'}
                    </button>
                    {!downloadsRef.current && (
                      <button className="st-btn tinted block" disabled={!d.exportable && override.trim().length < 5} onClick={() => void exportCrown(true)}>Share…</button>
                    )}
                    <p className="st-foot">Includes a .design.json with margin, parameters and checks, so the crown can be audited or reproduced.</p>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {newCase && <NewCase toothName={(n) => TOOTH_NAMES[toothClassOf(n)] ?? ''} onCancel={() => setNewCase(false)} onDone={(r) => void startCase(r)} />}
      {/* No `accept` filter on scan pickers: iOS greys out .stl/.eoff files; parsing reports unreadable ones. */}
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = '' }} />
      <input ref={libRef} type="file" multiple hidden onChange={(e) => { void importLibrary(e.target.files); e.target.value = '' }} />
      <input ref={rxRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onRxPhoto(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )

  function setLayerState(layer: 'antagonist' | 'heatmap'): void {
    viewRef.current?.setLayer(layer, 'toggle')
    setStatus(`${layer === 'heatmap' ? 'Thickness map' : 'Opposing jaw'} ${viewRef.current?.layerVisible(layer) ? 'on' : 'off'}.`)
    haptic()
  }
}

/** Universal tooth chart: upper arch 1–16 over lower 32–17, as on an Rx. */
function ToothChart(props: { value: number; onPick: (n: number) => void }): React.JSX.Element {
  const upper = Array.from({ length: 16 }, (_, i) => i + 1)
  const lower = Array.from({ length: 16 }, (_, i) => 32 - i)
  const row = (ns: number[]): React.JSX.Element => (
    <div className="st-chart-row">
      {ns.map((n) => (
        <button key={n} className={props.value === n ? 'on' : ''} onClick={() => props.onPick(n)} aria-label={`Tooth ${n}`} aria-pressed={props.value === n}>
          {n}
        </button>
      ))}
    </div>
  )
  return (
    <div className="st-chart">
      {row(upper)}
      {row(lower)}
      <div className="st-chart-key"><span>Patient right</span><span>Patient left</span></div>
    </div>
  )
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function Slider(props: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; hint?: string }): React.JSX.Element {
  return (
    <label className="st-slider">
      <span className="st-sl-label">
        <span>{props.label}{props.hint && <i> {props.hint}</i>}</span>
        <b>{props.value.toFixed(props.step < 0.1 ? 2 : props.step < 1 ? 1 : 0)} {props.unit}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  )
}
