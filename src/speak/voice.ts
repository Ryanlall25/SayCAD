/**
 * Voice input via the browser's built-in Web Speech API — no cloud key, no
 * SDK. Chrome/Edge/Safari ship it; Firefox doesn't yet, so the mic button
 * simply hides itself there and typing remains the universal path.
 */
type RecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechResultEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechResultEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition as RecognitionCtor) ?? (w.webkitSpeechRecognition as RecognitionCtor) ?? null
}

export interface Dictation {
  readonly supported: boolean
  /** Begin one utterance; resolves through the callbacks. */
  start(): void
  stop(): void
  readonly listening: boolean
}

export function createDictation(handlers: {
  onInterim(text: string): void
  onFinal(text: string): void
  onStateChange(listening: boolean): void
  onError(message: string): void
}): Dictation {
  const Ctor = recognitionCtor()
  let active: SpeechRecognitionLike | null = null

  const api = {
    supported: Ctor !== null,
    get listening() {
      return active !== null
    },
    start() {
      if (!Ctor || active) return
      const rec = new Ctor()
      rec.lang = 'en-US'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (e) => {
        let interim = ''
        let final = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]
          if (r.isFinal) final += r[0].transcript
          else interim += r[0].transcript
        }
        if (interim) handlers.onInterim(interim.trim())
        if (final) handlers.onFinal(final.trim())
      }
      rec.onend = () => {
        active = null
        handlers.onStateChange(false)
      }
      rec.onerror = (e) => {
        // 'no-speech'/'aborted' are routine; surface everything else.
        if (e.error && e.error !== 'no-speech' && e.error !== 'aborted')
          handlers.onError(`Microphone: ${e.error}`)
      }
      active = rec
      handlers.onStateChange(true)
      rec.start()
    },
    stop() {
      active?.stop()
    }
  }
  return api
}
