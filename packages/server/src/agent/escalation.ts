/**
 * @coder → @spec escalation (GH #137): the pure half.
 *
 * When @coder raises questions/expectations/scenarios while implementing, @spec is woken to triage them
 * — draft a proposal or sharpen a decision for the human, never decide a product fork itself. Nothing
 * here runs a turn; the runner detects @coder's raises and dispatches the @spec turn. This module holds
 * only the decisions that are worth testing in isolation: which tools count as a "raise", whether the
 * feature is on, and the notice + instruction @spec is woken with.
 *
 * Safe by construction: everything @spec does in response is inert until a human acts (a proposed
 * changeset changes nothing until applied; a question waits for an answer), so there is no autonomous
 * loop — a human is in every path back to @coder.
 */

const RAISE_TOOLS = new Set(['raise_question', 'raise_expectation', 'raise_scenario'])

/** True for the short tool name of a free-add @coder can emit that's worth waking @spec over. */
export function isRaiseTool(shortName: string): boolean {
  return RAISE_TOOLS.has(shortName)
}

/**
 * Whether @spec-proactive triage is enabled — off unless `SPEC_PROACTIVE` is `1`/`true`. Opt-in for
 * the open in-process path; a hosted deployment gates it with its own per-project toggle instead.
 */
export function specProactiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SPEC_PROACTIVE === '1' || env.SPEC_PROACTIVE === 'true'
}

const LABEL: Record<string, string> = {
  raise_question: 'question',
  raise_expectation: 'expectation',
  raise_scenario: 'scenario',
}

/** "2 questions and 1 scenario" — a readable roll-up of the raise tools @coder emitted this run. */
function summarize(raised: string[]): string {
  const counts = new Map<string, number>()
  for (const tool of raised) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  const parts = [...counts].map(([tool, n]) => `${n} ${LABEL[tool] ?? tool}${n === 1 ? '' : 's'}`)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The lead-in @spec posts when it wakes to triage — attributed to @spec, so the thread reads in order. */
export function triageNotice(raised: string[]): string {
  return `@coder raised ${summarize(raised)} while implementing — reviewing what needs a spec change and what needs a human decision.`
}

/** The instruction @spec acts on. Not a human message; this is the turn's prompt. */
export function triagePrompt(raised: string[]): string {
  return [
    `@coder raised ${summarize(raised)} during its last run — read them (read_questions, read_expectations, read_scenarios).`,
    'Triage what needs you: if @coder hit a clear glossary-mechanics fix — a missing term the code needs, a naming clash, two terms that contradict — propose a changeset (a human still applies it).',
    "If a raised expectation is contested (it disagrees with a term's spec), raise one question naming both sides for the human, as usual.",
    'Otherwise, if @coder already framed a genuine product decision as a clear question, leave it for the human — do not restate it.',
    'Never decide a product fork and never retire anything: a proposal changes nothing until a human applies it.',
  ].join(' ')
}

/**
 * The other half of proactive @spec (GH #150): a human's *answer* wakes @spec, where @coder's *raises*
 * wake it above. The trigger is a question @spec raised that was answered with no pre-drafted proposal
 * to mint — the open-design fork case, where the decision is now made but nothing bridges it to a
 * changeset. Same dial ({@link specProactiveEnabled}), same safety: @spec only proposes.
 */
export interface AnsweredForProposal {
  id: string
  /** The chosen option's label, or null when the human answered in prose without picking one. */
  chose: string | null
  note: string
}

/** The lead-in @spec posts when a decision wakes it — attributed to @spec, so the thread reads in order. */
export function answerProposalNotice(answered: AnsweredForProposal): string {
  return `${answered.id} was answered — drafting the changeset that decision implies for you to review.`
}

/** The instruction @spec acts on after a human answers a question it raised. The turn's prompt, not a human message. */
export function answerProposalPrompt(answered: AnsweredForProposal): string {
  const decision = answered.chose
    ? `the human chose "${answered.chose}"`
    : 'the human answered in prose without taking one of the options'
  const note = answered.note.trim() ? ` They noted: "${answered.note.trim()}".` : ''
  return [
    `A question you raised, ${answered.id}, was just answered: ${decision}.${note}`,
    'Read it (read_questions) and propose the changeset that decision now implies, so nothing is left for the human to hand-implement.',
    'If the decision turns out to need no glossary change, say so plainly and propose nothing.',
    'Do not decide anything the answer left open, and do not treat this as a new fork to settle: a proposal changes nothing until a human applies it.',
  ].join(' ')
}
