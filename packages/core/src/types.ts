/**
 * The glossary schema. These types are the contract between the human authoring
 * specs in the UI and the AI agent that implements them — everything else in this
 * repo is a view over data shaped like this.
 */

/**
 * Who made a write. The kind distinguishes a person from the two agents; it is stamped
 * server-side from the route or the agent definition, never taken from the client, so an actor
 * in the sandbox cannot claim to be a human. `user` is the human account — absent until auth
 * exists, and for an agent action it is eventually the human whose session it was.
 *
 * This is identity, kept separate from the `raisedBy` origin (which records *why* and in what
 * pass). Optional on the records below: absent means the record predates identity tracking,
 * the same way `appliedAt` is absent on changesets applied before it was recorded.
 */
export type AuthorKind = 'human' | 'spec' | 'coder'

export interface Author {
  kind: AuthorKind
  user?: string
}

/**
 * Whether a human-authored artifact is still being drafted or has been published to the team.
 *
 * `ready` is the published state — it counts as coverage, rides in the versioned contract, and
 * the agents see it. `draft` is author-only and part of nothing until it is published, the same
 * way a draft PR is not yet a request for review. Optional on the records below: absent means
 * `ready`, so the specs already on disk (all published) need no rewrite. Agents always raise
 * `ready`; drafting is a human convenience.
 */
export type RecordStatus = 'draft' | 'ready'

/**
 * Who this glossary is, in one place. `name` is the display title (the UI header) and what the
 * agents are told they are working on; `domain` is a one-line description of the subject the
 * glossary describes — the framing an agent reads before it has read a single term.
 *
 * This is glossary *content*, not deployment config: it describes the project itself, so it is
 * retrieved through the SpecStore (a file for the filesystem backend, a row for SQL, per-tenant
 * once hosted) rather than baked into a prompt string. The *link* to a hosted project — endpoint,
 * project id, credentials — is a separate, bootstrap concern and does not live here.
 */
export interface ProjectInfo {
  name: string
  domain: string
  /**
   * System Brief (GH #143): free-prose product framing *above* the domain — what is being built
   * (engine / API / app + UI), for whom, and how it is used. The domain says what the concepts
   * *mean*; the brief says what the *thing* is, which is the single biggest input to what @coder
   * builds. Injected into both agents' prompt (see `sharedPrompt`) so it steers every turn, not
   * just a file an agent might read. Absent until authored. NOT tech/architecture decisions —
   * those are ADRs (#144).
   */
  brief?: string
}

export type TermType = 'entity' | 'event' | 'function' | 'attribute-type'

export const TERM_TYPES: readonly TermType[] = [
  'entity',
  'event',
  'function',
  'attribute-type',
]

export interface Attribute {
  name: string
  /** A primitive (`string`, `number`, `boolean`, `date`) or `ref:<TermName>`, either with an optional `[]` suffix. */
  valueType: string
  default?: unknown
  optional?: boolean
}

export interface Term {
  name: string
  type: TermType
  /** Short natural-language description — spec-worthy, precise enough to generate tests from. */
  spec: string
  /** Single supertype (is-a), or null. */
  parent: string | null
  /** Free cross-cutting labels; not a hierarchy. */
  tags: string[]
  attributes: Attribute[]
}

/** How the AI (or a hand-authored fixture) proposes an edit: structured ops, never free text. */
export type Op =
  | {
      op: 'add_entity'
      term: string
      /** Defaults to `entity`; carries the other kinds so one op can add functions and events too. */
      termType?: TermType
      parent?: string | null
      spec: string
      tags?: string[]
      attributes?: Attribute[]
    }
  | { op: 'remove_entity'; term: string }
  | { op: 'add_attribute'; term: string; attribute: Attribute }
  | { op: 'remove_attribute'; term: string; attribute: string }
  | { op: 'modify_spec'; term: string; spec: string }

export type OpKind = Op['op']

export interface Changeset {
  id: string
  summary: string
  ops: Op[]
  /** Plain-language test intentions; a changeset carrying passing tests is safer to auto-approve. */
  tests: string[]
  /** Who proposed it. Absent on changesets minted before identity was tracked. */
  author?: Author
  /** Set when this changeset was minted by answering a Question — the id of that question. */
  fromQuestion?: string
  /** ISO timestamp, written when the changeset lands. Absent while it is still pending. */
  appliedAt?: string
  /**
   * When code was written for this change. `null` means applied but not yet implemented —
   * the state the `implements:` markers cannot detect, because a rewritten spec leaves
   * every marker looking correct. Absent on changesets applied before this was tracked.
   */
  implementedAt?: string | null
}

/**
 * A question raised against the glossary — normally by an agent that tried to implement
 * it and hit something the specs do not settle.
 *
 * The unit here is deliberately a *question*, not a "finding": if an entry cannot be
 * phrased as something the human answers, it does not belong in the queue. That rules out
 * the observations an implementation pass would otherwise flood it with, and it keeps the
 * agent from quietly making product decisions by dressing a guess up as a proposal.
 */
export interface Question {
  id: string
  /** The question itself, answerable as written. */
  asks: string
  /** Why it is being asked — must quote the spec text in conflict, not just describe inconvenience. */
  because: string
  raisedBy: QuestionOrigin
  /** Who raised it. Absent on questions raised before identity was tracked. */
  author?: Author
  /** Draft or published. Absent means `ready`. Agent-raised questions are always `ready`. */
  status?: RecordStatus
  /**
   * Bumped by the store on every write. A caller that read revision N can send it back as the
   * expected revision on its next write; the store refuses if the record has moved since. Absent
   * means 1 — the birth value and what a record predating this reads as.
   */
  rev?: number
  /**
   * Candidate answers. The count is the answer shape, so there is no separate field to
   * keep in sync: one option is approve-or-decline, several is a choice, none means only
   * the human can write the spec text.
   */
  options: QuestionOption[]
  /**
   * Raised by @coder as *blocking* when it cannot correctly finish implementing the applied
   * changeset(s) without this answer (GH #137). An attention signal about implementation state,
   * not a domain fact — only @coder originates it (it is the one actor that knows whether it can
   * proceed), and a human may override it either way. It floats the question to the top of the
   * queue. Effective only while the question is open: an answered question blocks nothing, so a
   * consumer reads it as `blocking && !answer` rather than the flag alone. Absent means not blocking.
   */
  blocking?: boolean
  /** Null while open. Kept after answering — the reasoning outlives the changeset. */
  answer: Answer | null
}

export interface QuestionOrigin {
  /** What was being done when it came up, e.g. `implementation`. */
  pass: string
  file?: string
  /** Terms the question is about, so it can be shown against them in the glossary. */
  terms: string[]
}

export interface QuestionOption {
  label: string
  /** The tradeoff in plain language, including what answering this way costs. */
  detail?: string
  /** What would go into the pending queue. Null when this option changes no specs. */
  proposal: Proposal | null
}

/** A changeset body without an id — the id is minted when the option is chosen. */
export interface Proposal {
  summary: string
  ops: Op[]
  tests: string[]
}

export interface Answer {
  /** Label of the chosen option, or null when the human answered without taking one. */
  chose: string | null
  note: string
  /** ISO timestamp. */
  answeredAt: string
  /** Id of the changeset this answer put into the pending queue, if any. */
  changesetId?: string
  /** Who answered. Absent on answers recorded before identity was tracked. */
  author?: Author
}

/**
 * What someone should be able to expect, stated outside the prose.
 *
 * A Term says what something *is*; an Expectation says what *happens* in a specific case.
 * Both are normative, and keeping them apart buys three things the prose cannot:
 *
 * - Expectations accumulate. Using the app turns up scenarios nobody thought of the first
 *   time, and adding one must not mean rewriting a definition that was already correct.
 * - They are addressable. An id is what lets a test name cite one, a QA agent resolve one,
 *   and a review notice two that say the same thing.
 * - They are countable against the vocabulary, which is what makes coverage computable —
 *   see `coverage.ts`.
 *
 * Deliberately *not* a Term. A Term is roughly a class, a thing the product has; an
 * Expectation is a statement about the vocabulary rather than part of it. Making it a
 * `TermType` would hand it a parent, attributes, a slot in the glossary browser beside Task,
 * and a demand for an `implements:` marker — none of which mean anything here. It sits in the
 * same tier as Question and Changeset: first-class, references terms, is not one.
 */
/**
 * `functional` — a scenario over the vocabulary (given/when/then), becomes an example test.
 * `non-functional` — a property of an implementation (latency, a11y, persistence), exempt from the
 *   vocabulary rule, checked by driving a running build.
 * `invariant` — a property of the domain that must ALWAYS hold (`on-hand ≥ 0`, `a transfer conserves
 *   total stock`), not a single case. Like a functional expectation it is phrased in glossary
 *   vocabulary and names the terms it constrains; unlike one it is universal, so it verifies as a
 *   *property* (true in every state) rather than a single example. It is a kind of expectation, not a
 *   rival concept — it reuses the whole Expectation record — because "what must be true" belongs in the
 *   same layer as "what should happen".
 */
export type ExpectationKind = 'functional' | 'non-functional' | 'invariant'

export type ClashKind =
  /** Names a term the glossary does not have. */
  | 'unknown-term'
  /** Says what a live expectation already says. */
  | 'duplicate'
  /** Concerns exactly the same terms as a live one, in different words. */
  | 'overlaps'
  /** Cannot hold at the same time as a term's spec. */
  | 'contradicts'
  /** Restates a spec without adding a scenario. */
  | 'restates'

/** Something a draft clashed with, quoted rather than described so both can be read together. */
export interface Clash {
  kind: ClashKind
  /** The term name or expectation id this is about. */
  subject: string
  detail: string
  quote?: string
}

export interface Expectation {
  id: string
  /**
   * Which verifier this is for, and that is the whole reason the field exists rather than
   * taxonomy for its own sake. A functional expectation is phrased in glossary vocabulary and
   * becomes a unit test over the domain. A non-functional one — latency, accessibility,
   * persistence — is a property of an implementation, which this glossary deliberately does
   * not constrain, so it is exempt from the vocabulary rule and is checked by driving a
   * running build instead.
   *
   * It is stored rather than derived: emptiness of `terms` looked like it would encode this,
   * but "listing Tasks in a Project holding ten thousand Tasks stays responsive" is
   * non-functional and names two terms.
   */
  kind: ExpectationKind
  /** Who raised it. Absent on expectations raised before identity was tracked. */
  author?: Author
  /**
   * Draft or published. Absent means `ready`. A draft counts toward nothing — not coverage,
   * not the versioned contract, and the agents do not see it — until it is published.
   */
  status?: RecordStatus
  /** Store revision, bumped on every write; the basis for optimistic concurrency. Absent means 1. */
  rev?: number
  /** Glossary terms this concerns. May be empty for a non-functional expectation that scopes to the whole app. */
  terms: string[]
  /** The situation. Empty when the expectation is unconditional. */
  given: string
  /** What must hold. For a functional expectation, phrased using only glossary vocabulary. */
  expect: string
  raisedBy: ExpectationOrigin
  /**
   * Id of the expectation that replaced this one, or null while it is live.
   *
   * Expectations move — a decision changes, or the first phrasing was imprecise — and an
   * edit in place would lose both the old wording and the reason. So they are superseded
   * rather than rewritten, the same way an answer stays in its question file and a changeset
   * moves to `applied/` instead of vanishing. Three things fall out: a test named `e-014`
   * still resolves years later, the reasoning is not re-derived, and the one dangerous
   * direction — quietly weakening an expectation to turn a red check green — leaves an
   * artifact in the history that is already reviewed.
   */
  supersededBy: string | null
  /**
   * Why it stopped applying. Written when it is retired, absent while it is live — the one
   * field that only ever appears on a retired copy, because a live expectation has no such
   * reason to record.
   */
  retiredBecause?: string
  /**
   * What this clashed with, and was written down anyway.
   *
   * The check that finds these does not refuse the write, deliberately: a draft that
   * contradicts a spec is often a legitimate thing to want that the glossary does not allow
   * yet, and a model deciding what you may expect from your own product is the wrong
   * authority. But a finding that lives only in the browser for the second before you click
   * is worse than no finding — the expectation then lands looking exactly like one that came
   * back clean, and nothing downstream can tell the difference.
   *
   * So the disagreement travels with the statement. An implementer reading this knows not to
   * go and make it true, because the glossary currently says otherwise and only a human can
   * settle which gives. Empty means it was checked and clean, or predates the check.
   */
  contested: Clash[]
}

export interface ExpectationOrigin {
  /** What was being done when it came up, e.g. `implementation`, `usage`, `review`. */
  pass: string
  /** Question or changeset it follows from, if any. */
  from?: string
  file?: string
}

/**
 * A Scenario — a stored, cross-entity spec-level test case: the integration-test tier to
 * Expectations' unit tier. Where an Expectation is one Given/When/Then, usually about a single
 * entity, a Scenario walks a concrete situation across several terms and asserts an outcome — and
 * its worth is exactly that combination, which is *emergent*, not reconstructable from the
 * individual entities' expectations. So it is stored rather than re-derived by re-prompting:
 * curated, versioned, re-openable.
 *
 * v1 is deliberately light — add-only; steps and assertions are prose, and simultaneity ("both
 * check out at once") is stated in that prose. A structured step/concurrency model, the
 * supersede/verify machinery, coverage and the diagram are later slices.
 */
export interface Scenario {
  id: string
  /** A short name for the situation — what this scenario is about. */
  title: string
  /** Who raised it. Absent on scenarios raised before identity was tracked. */
  author?: Author
  /** Glossary terms the scenario touches — cross-entity by nature; at least one. */
  terms: string[]
  /** The setup: the initial state across the terms it touches. Empty when there is none. */
  given: string
  /** Ordered steps of the walkthrough. Simultaneity is stated in the prose in v1. */
  steps: string[]
  /** What must hold — one or more assertions, phrased in glossary vocabulary. */
  expect: string[]
  raisedBy: ScenarioOrigin
}

export interface ScenarioOrigin {
  /** What was being done when it came up, e.g. `implementation`, `usage`, `review`. */
  pass: string
  /** A question, changeset, or expectation it follows from, if any. */
  from?: string
  file?: string
}

export type Severity = 'error' | 'warning'

export interface Diagnostic {
  /** Index into the op list this diagnostic belongs to, or null when it describes the resulting state as a whole. */
  opIndex: number | null
  severity: Severity
  message: string
}

/** A term file that could not be read or did not match the schema. Surfaced in the UI instead of crashing. */
export interface SourceProblem {
  file: string
  message: string
}
