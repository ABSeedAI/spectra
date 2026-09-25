/**
 * Answering a question, over the {@link SpecStore} seam.
 *
 * Two things happen and both matter: the answer is written back into the question, where it stays as
 * the record of *why* the glossary says what it says, and the chosen option's proposal is minted into
 * the pending changeset queue, where it goes through the same review the human already has. Nothing is
 * applied — answering decides the intent; applying the changeset it produces is a separate act.
 *
 * Pure, so it lives in core beside the seam — every coordinator answers identically.
 */
import type { Answer, Author, Changeset } from './types.js'
import type { SpecStore } from './specStore.js'

/** A short, filename-safe id fragment from an option label. Inlined so this stays free of I/O deps. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'option'
  )
}

export type AnswerOutcome =
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; error: string }
  | {
      ok: true
      questionId: string
      answer: Answer
      /** Set when the chosen option carried a proposal. */
      changesetId?: string
      changesetFile?: string
      /**
       * Who raised the question being answered — surfaced so a caller can decide whether to wake
       * that author to act on the decision (GH #150: a @spec-raised question, answered without a
       * pre-drafted proposal, is the case where @spec should propose the changeset it now implies).
       */
      questionAuthor?: Author
    }

export interface AnswerRequest {
  /** Label of the chosen option, or null to answer in prose without taking one. */
  chose: string | null
  note: string
  /** ISO timestamp; the caller's clock, so this stays testable. */
  answeredAt: string
}

export async function answerQuestion(
  store: SpecStore,
  id: string,
  request: AnswerRequest,
  author: Author,
): Promise<AnswerOutcome> {
  const question = await store.findQuestion(id)
  if (!question) return { ok: false, status: 404, error: `No question with id "${id}".` }

  // A decision is a record, not a setting. Changing your mind means a new question (or a
  // hand-edit), so the reasoning that was acted on cannot be quietly overwritten.
  if (question.answer) {
    return {
      ok: false,
      status: 409,
      error: `"${id}" was already answered on ${question.answer.answeredAt}. Raise a new question rather than overwriting the decision.`,
    }
  }

  const option =
    request.chose === null
      ? null
      : question.options.find((candidate) => candidate.label === request.chose)

  if (request.chose !== null && !option) {
    return { ok: false, status: 400, error: `"${id}" has no option labelled "${request.chose}".` }
  }
  if (request.chose === null && !request.note.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'Answering without choosing an option requires a note saying what to do instead.',
    }
  }

  const answer: Answer = {
    chose: request.chose,
    note: request.note,
    answeredAt: request.answeredAt,
    author,
  }

  let changesetFile: string | undefined

  if (option?.proposal) {
    const changesetId = `${question.id}-${slug(option.label)}`
    const changeset: Changeset = {
      id: changesetId,
      summary: option.proposal.summary,
      ops: option.proposal.ops,
      tests: option.proposal.tests,
      fromQuestion: question.id,
      author,
    }

    // Written before the answer: if the process dies between the two, an unreferenced changeset
    // in the queue is noise someone notices, where an answer citing a changeset that was never
    // written is a dangling reference.
    changesetFile = await store.addChangeset(changeset)
    answer.changesetId = changesetId
  }

  // No expectedRev here: a question's one mutation is being answered, and the "already answered"
  // guard above is that record's optimistic-concurrency check. writeAnswer still bumps the rev.
  const written = await store.writeAnswer(id, answer)
  if (!written.ok) {
    // Only 'not-found' is reachable without an expectedRev — the question vanished mid-answer.
    return { ok: false, status: 404, error: `No question with id "${id}".` }
  }

  return {
    ok: true,
    questionId: question.id,
    answer,
    ...(answer.changesetId ? { changesetId: answer.changesetId } : {}),
    ...(changesetFile ? { changesetFile } : {}),
    ...(question.author ? { questionAuthor: question.author } : {}),
  }
}
