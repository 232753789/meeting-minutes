/** Groups VAD-final ASR fragments into stable interview questions. */

/** One final ASR fragment awaiting a complete-question decision. */
export interface QuestionFragment {
  readonly index: number
  readonly text: string
  readonly seconds: number
}

/** One question released for triage and answering. */
export interface QuestionCandidate {
  readonly sourceIndex: number
  readonly text: string
  readonly seconds: number
}

const INCOMPLETE_ENDINGS = [
  '因为', '所以', '但是', '然后', '如果', '当', '在', '和', '与', '以及', '或者',
  '关于', '通过', '从', '到', '把', '被', '能不能', '有没有', '为什么', '如何', '怎么',
  '是否', '请你', '你们', '负责', '还', '就是', '那个', '然后',
] as const

const QUESTION_MARK = /[？?]/u
const SENTENCE_END = /[。！？!?；;]$/u
const QUESTION_BOUNDARY = /(?=另外(?:一个问题)?|还有(?:一个问题)?|再问一个|第二个问题)/u

function cleanText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function endsWithIncompletePhrase(text: string): boolean {
  const normalized = text.replace(/[，,、。；;：:]$/u, '').trim()
  return INCOMPLETE_ENDINGS.some(ending => normalized.endsWith(ending))
}

function splitAtQuestionBoundaries(text: string): string[] {
  const punctuated = text
    .split(/(?<=[。！？!?；;])/u)
    .map(cleanText)
    .filter(Boolean)
  const parts: string[] = []
  for (const sentence of punctuated) {
    const split = sentence.split(QUESTION_BOUNDARY).map(cleanText).filter(Boolean)
    parts.push(...split)
  }
  return parts
}

function isComplete(text: string): boolean {
  if (SENTENCE_END.test(text) || QUESTION_MARK.test(text)) return true
  if (endsWithIncompletePhrase(text)) return false
  return true
}

function joinFragments(fragments: readonly QuestionFragment[]): string {
  return cleanText(fragments.map(fragment => fragment.text).join(''))
}

function release(fragments: readonly QuestionFragment[]): QuestionCandidate[] {
  const text = joinFragments(fragments)
  if (text === '') return []
  const last = fragments.at(-1)
  if (last === undefined) return []
  const parts = splitAtQuestionBoundaries(text)
  return parts.map((part, offset) => ({
    sourceIndex: last.index + offset,
    text: part,
    seconds: Math.round(fragments.reduce((total, fragment) => total + fragment.seconds, 0) * 1_000) / 1_000,
  }))
}

/**
 * Holds fragments that end in a grammatical continuation and releases complete questions.
 *
 * VAD remains responsible for acoustic endpointing. This class adds the missing textual state:
 * a pause after a connective does not publish a question, while an utterance with a question cue
 * or a clear sentence ending is released immediately. A caller that owns a graceful recognizer
 * stop may call {@link flush} to publish its final buffered context. Session teardown intentionally
 * does not do so because it aborts model work and must not append a new answer after the socket has
 * closed.
 */
export class QuestionAccumulator {
  private pending: QuestionFragment[] = []

  /**
   * Add one final ASR fragment.
   * @param fragment - VAD-final transcript and its source duration.
   * @returns stable question candidates, or an empty list while context is incomplete.
   */
  push(fragment: QuestionFragment): QuestionCandidate[] {
    const text = cleanText(fragment.text)
    if (text === '') return []
    this.pending.push({ ...fragment, text })
    const combined = joinFragments(this.pending)
    if (!isComplete(combined)) return []
    const released = release(this.pending)
    this.pending = []
    return released
  }

  /**
   * Release the final buffered context during recognizer shutdown.
   * @returns candidates for the buffered text.
   */
  flush(): QuestionCandidate[] {
    const released = release(this.pending)
    this.pending = []
    return released
  }
}

/**
 * Test-facing completeness predicate for calibration against recorded interviews.
 * @param text - candidate question text.
 * @returns whether the text is complete enough to release.
 */
export function questionTextIsComplete(text: string): boolean {
  return isComplete(cleanText(text))
}
