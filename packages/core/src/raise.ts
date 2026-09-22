/**
 * Raising a question — the one write an agent is allowed to make against the glossary, over the
 * {@link SpecStore} seam.
 *
 * Like {@link proposeChangeset}, it lives in `@abseed/spectra-core` because it is pure and both the open
 * server and an out-of-repo backend must raise a question identically — one operation, one meaning.
 *
 * Safe by construction: a question changes no term and applies no op. It is a request for a decision,
 * and every path out of it (answering, then reviewing the changeset it mints) still runs through the
 * human. That is why this needs no approval prompt while `proposeChangeset` will.
 */
import { parseQuestion } from './schema.js'
import type { Author, Proposal, Question, QuestionOption, RecordStatus } from './types.js'
import type { SpecStore } from './specStore.js'

export interface RaiseRequest {
  asks: string
  because: string
  pass: string
  file?: string
  terms: string[]
  options: Array<{ label: string; detail?: string; proposal?: Proposal | null }>
  /** Draft or published. Absent means `ready`; agents always raise `ready`. */
  status?: RecordStatus
  /**
   * Marks the question blocking (GH #137) — set by @coder when it cannot finish implementing
   * without the answer. Honoured only for a `coder` author: blocking is an implementation-state
   * signal, so a request from any other author is ignored (see below).
   */
  blocking?: boolean
}

export type RaiseOutcome =
  | { ok: false; error: string }
  | { ok: true; id: string; file: string; question: Question }

export async function raiseQuestion(
  store: SpecStore,
  request: RaiseRequest,
  author: Author,
): Promise<RaiseOutcome> {
  const id = await store.nextQuestionId()

  const options: QuestionOption[] = request.options.map((option) => ({
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {}),
    proposal: option.proposal ?? null,
  }))

  // Blocking is a fact about @coder's implementation state, so only @coder may set it at raise
  // time; a human overrides later through setQuestionBlocking. Kept off the record when false so
  // question files stay minimal (a fixed, small key set), matching the serializer elsewhere.
  const blocking = author.kind === 'coder' && request.blocking === true

  const question: Question = {
    id,
    asks: request.asks,
    because: request.because,
    raisedBy: {
      pass: request.pass,
      ...(request.file ? { file: request.file } : {}),
      terms: request.terms,
    },
    author,
    status: request.status ?? 'ready',
    rev: 1,
    options,
    ...(blocking ? { blocking: true } : {}),
    answer: null,
  }

  // Validate before writing rather than after: a malformed question would otherwise land on
  // disk and come back as a source problem in the UI.
  const parsed = parseQuestion(question)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') }

  const file = await store.addQuestion(question)
  return { ok: true, id, file, question }
}
