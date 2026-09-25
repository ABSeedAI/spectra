/**
 * Enriching a question — @spec augmenting an *existing, unanswered* question with well-formed
 * options + proposals, instead of raising a separate refined question (GH #165).
 *
 * This collapses the @coder→@spec round-trip into one reviewable thread: @coder raises a rough,
 * proposal-less question; @spec, triaging it, fills in the choices (each option carrying the
 * changeset it would raise as its `proposal`) on that same question rather than creating a parallel
 * card. Like {@link raiseQuestion} it is pure and lives in core, so the open server and an
 * out-of-repo backend enrich identically.
 *
 * Safe by construction, and crucially *pre-answer*: adding or replacing options is laying out the
 * fork, not deciding it, so it does not violate "answers are immutable; raise a new question to
 * change a decision." An already-answered question is refused here — its options stand behind a
 * recorded choice. The store write is compare-and-swapped on the revision we read, so a decision
 * that lands in the gap is never clobbered.
 */
import { parseQuestion } from './schema.js'
import type { Author, Proposal, Question, QuestionOption } from './types.js'
import type { SpecStore } from './specStore.js'

export interface EnrichRequest {
  /** The existing, unanswered question to enrich. */
  id: string
  /** The new option set — replaces the question's current options wholesale. */
  options: Array<{ label: string; detail?: string; proposal?: Proposal | null }>
}

export type EnrichOutcome =
  | { ok: false; error: string }
  | { ok: true; id: string; file: string; question: Question }

export async function enrichQuestion(
  store: SpecStore,
  request: EnrichRequest,
  _author: Author,
): Promise<EnrichOutcome> {
  const existing = await store.findQuestion(request.id)
  if (!existing) return { ok: false, error: `No question with id "${request.id}".` }

  // Enrichment is pre-answer only. Once a question is answered its options sit behind a recorded
  // decision; changing the fork means a new question, never editing the choices under the old one.
  if (existing.answer) {
    return {
      ok: false,
      error: `"${request.id}" was already answered on ${existing.answer.answeredAt}. Raise a new question rather than editing the options behind a decision.`,
    }
  }

  const options: QuestionOption[] = request.options.map((option) => ({
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {}),
    proposal: option.proposal ?? null,
  }))

  // Validate the whole question with its new options before writing rather than after: a malformed
  // option set would otherwise land on disk and come back as a source problem in the UI.
  const candidate: Question = { ...existing, options }
  const parsed = parseQuestion(candidate)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') }

  // Compare-and-swap on the rev we read: if a concurrent write (an answer, a blocking toggle) landed
  // in the gap, refuse rather than overwrite it — enrichment must never clobber a fresher record.
  const written = await store.updateQuestionOptions(request.id, options, existing.rev ?? 1)
  if (!written.ok) {
    if (written.reason === 'not-found') return { ok: false, error: `No question with id "${request.id}".` }
    return {
      ok: false,
      error: `"${request.id}" changed while being enriched (it is now at rev ${written.currentRev}). Re-read it and enrich again.`,
    }
  }
  return { ok: true, id: request.id, file: written.at, question: { ...candidate, rev: written.rev } }
}
