/**
 * Continue a turn that the model cut off at its output limit, instead of treating it as finished (GH #156).
 *
 * A turn can stop with `stop_reason: "max_tokens"` mid-generation — the model had decided to write a
 * changeset but ran out of output budget before emitting the tool call. The SDK reports this as a
 * *success* result (there is no `error_max_tokens` subtype), so a loop that only checks `subtype` reads
 * a truncated turn as a completed one: nothing was written, and the only signal is a trailing cut-off.
 *
 * The fix is to continue: re-request from the *resumed* SDK session (never a restart — a restart would
 * replay the original prompt and re-fire the unguarded `raise_*` writes it already made), up to a bounded
 * number of times, so a long-but-valid changeset lands across two model calls instead of dying on the
 * first. When the budget of continuations is spent and the turn is still truncated, that is surfaced
 * plainly rather than left as a silent stall — the case that matters most on the unattended paths
 * (proactive @spec, auto-implement), where no human is watching the cutoff.
 *
 * This module is the pure, testable core of that decision. The turn loops (the in-process
 * {@link ./runner.ts} and the sandbox runtime's engine) own the actual `for await` and the resume;
 * they only ask this module what to do after each result and what to say when continuing.
 */

/** How many times a single turn may be auto-continued after a max_tokens cutoff before giving up. */
export const MAX_TOKEN_CONTINUATIONS = 3

/**
 * The prompt for a continuation turn. It runs against the *resumed* session, so the model already has
 * its own cut-off reply in context; this only tells it to finish, and warns it off repeating work or
 * re-running a tool call that already succeeded (the resume-not-restart guarantee at the prose level).
 */
export const CONTINUATION_PROMPT =
  'Your previous reply was cut off at the output limit before you finished. Continue exactly where you left off and complete it — if you were partway through a tool call (for example a changeset), issue it now. Do not repeat text you already wrote, and do not re-run a tool call that already succeeded.'

/**
 * What a turn loop should do after a `result` message.
 * - `done` — a natural end (or any non-`max_tokens` stop); leave the loop.
 * - `continue` — the turn truncated and there is continuation budget left; resume and re-request.
 * - `exhausted` — the turn truncated but the continuation budget is spent; surface it and stop.
 *
 * Pure: the branch depends only on the reported subtype/stop_reason and how many continuations have
 * already been used, so the whole decision is testable without a live model.
 */
export function afterResult(input: {
  subtype: string
  stopReason: string | null | undefined
  continuationsUsed: number
}): 'done' | 'continue' | 'exhausted' {
  const truncated = input.subtype === 'success' && input.stopReason === 'max_tokens'
  if (!truncated) return 'done'
  return input.continuationsUsed < MAX_TOKEN_CONTINUATIONS ? 'continue' : 'exhausted'
}

/** What to record when the continuation budget is spent and the turn is still unfinished. */
export function truncationExhaustedNotice(continuationsUsed: number): string {
  return `The reply was cut off at the output limit and could not finish after ${continuationsUsed} automatic continuation${continuationsUsed === 1 ? '' : 's'}. Ask it to continue, or split the work into smaller changes.`
}
