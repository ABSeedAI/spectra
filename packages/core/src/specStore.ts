/**
 * The storage seam for the glossary (GH #3).
 *
 * It lives in `@abseed/spectra-core`, the pure package, on purpose: this interface is the stable public
 * boundary an out-of-repo store implements, and an implementor should depend on it without pulling
 * in a server's Express/agent machinery. It references only domain types (from `./types.js` and
 * `./schema.js`), so it belongs with them. The built-in filesystem and SQL backends live in
 * `@abseed/spectra-server`; a hosted/networked backend is just another implementation of this contract.
 *
 * Why this exists: specs are a shared human artifact, not a byproduct of the code. To make
 * them centrally visible to a team (and later multi-tenant/hosted), the content of `specs/`
 * has to be able to live somewhere other than the local filesystem. This interface is the
 * one place that decides *where*; `FileSystemSpecStore` (today's behaviour) and a future
 * `SqlSpecStore` are peers behind it. "Hosted" is a deployment axis, not a third backend.
 *
 * The boundary, stated so we do not blur it:
 *   - SpecStore is PERSISTENCE ONLY — reads, id allocation, and writes. Domain logic stays
 *     in the caller: the changeset engine (`applyOps`), validation (`parseTerm`/…),
 *     diagnostics, and version-guard decisions all remain in commit.ts / propose.ts /
 *     answer.ts / raise.ts / expectations.ts, which compose a SpecStore rather than living
 *     inside it.
 *   - Records are addressed by DOMAIN ID (`term.name`, `changeset.id`, `q-…`, `e-…`). No
 *     filename or path is used to *address* anything — the FS impl keeps its id→file map
 *     private, which is what lets a SQL row id stand in with no change to the caller. The one
 *     value that crosses the line is `StoredAt`, returned by the create methods purely so the
 *     caller can echo "where it landed" in a response; it is opaque and never parsed.
 *   - STATE IS DATA, NOT LOCATION. Today "applied" means a file sits in `applied/` and
 *     "retired" means it sits in `retired/`; here those are state transitions named as
 *     methods. The reads still return the partitioned view; only the FS impl backs it with
 *     folders.
 *   - `problems` survives: a record that will not load is reported, not thrown. It is an FS
 *     truth today (hand-edited files) but an API backend can return partial data too. What
 *     does NOT survive is "re-read from disk every call" — that is an FS detail.
 *
 * Optimistic concurrency (GH #93): a changeset is computed against the glossary as the reviewer saw
 * it, but applied later — possibly after someone else applied first. `commitApplication` takes an
 * optional `baseVersion` (a {@link glossaryVersion} token) and compare-and-swaps on it: the write
 * lands only if the glossary is still at that version, else it returns a {@link CommitConflict} and
 * writes nothing. Absent `baseVersion` keeps the old last-write-wins behaviour, so existing callers
 * and single-writer deployments are unaffected. The token is derived from the terms (not a stored
 * `version()` method), so it always matches the terms a caller just read.
 *
 * Not in scope: `data/transcripts.db` (chat history, its own store) and the offline snapshot /
 * `specs.snapshot.json` version guard (that is `specsSnapshot`, terms + expectations, for the
 * mark_implemented drift check — a different token for a different job).
 */
import type {
  Answer,
  Changeset,
  Expectation,
  Op,
  ProjectInfo,
  Question,
  Scenario,
  SourceProblem,
  Term,
} from './types.js'

// ── Partitioned read shapes (relocated here from store.ts — this interface is their home) ──

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
}

export interface PendingChangesets {
  changesets: Changeset[]
  problems: SourceProblem[]
  /**
   * What has landed and what was turned down, newest first. Each entry is a distinct set of
   * ops, so a changeset applied in two partial passes appears twice — the honest count.
   */
  applied: Changeset[]
  rejected: Changeset[]
}

export interface QuestionFeed {
  questions: Question[]
  problems: SourceProblem[]
}

export interface ExpectationFeed {
  /** Published, live expectations — what is currently expected to hold. Excludes drafts. */
  expectations: Expectation[]
  /**
   * Drafts — live but not yet published, so they count toward nothing (coverage, the versioned
   * contract, the agents' view) and are returned only for their author's own authoring UI.
   */
  drafts: Expectation[]
  /** Superseded ones, kept so a test citing a retired id still resolves and the reason survives. */
  retired: Expectation[]
  problems: SourceProblem[]
}

export interface ScenarioFeed {
  /** Stored scenarios — cross-entity, spec-level test cases. */
  scenarios: Scenario[]
  problems: SourceProblem[]
}

/**
 * Where the store put a newly created record. Opaque to callers — a filename for the
 * filesystem backend, a row id for SQL — echoed back in responses, never parsed.
 */
export type StoredAt = string

/**
 * One atomic application (#1, Trap 1). commit.ts runs the engine to produce the post-image,
 * then hands the whole thing here as ONE call so the term writes and the pending→applied move
 * commit together. On the filesystem this is the `writeAtomic` dance (which can half-land
 * across files); on SQL it becomes a real transaction.
 */
export interface CommitApplication {
  /** The pending changeset being (partially) applied. */
  changesetId: string
  /** Full post-image of the glossary the engine produced — the store reconciles disk to this. */
  nextTerms: Term[]
  /** The ops that landed, recorded into the applied record. */
  appliedOps: Op[]
  /** Ops left unselected: they stay pending. Empty means the pending changeset is removed. */
  remainingOps: Op[]
  /** Caller's clock, so this stays testable. */
  appliedAt: string
  /**
   * Optimistic-concurrency guard (GH #93): the {@link glossaryVersion} the caller computed `nextTerms`
   * against. When present, the store writes only if the glossary is still at this version, else it
   * returns a {@link CommitConflict}. Absent = last-write-wins (the prior behaviour).
   */
  baseVersion?: string
}

/** What changed, in the store's own terms (filenames for FS, opaque strings for SQL). */
export interface CommitResult {
  written: string[]
  deleted: string[]
  /** Where the applied record now lives — the old relative-path `resolvedTo`, kept verbatim. */
  resolvedTo: string
}

/**
 * A refused commit: the glossary moved past `baseVersion` between the caller reading it and the
 * write, so nothing was written. `currentVersion` is where it is now — a fact for the caller to
 * compare, never a verdict (the same shape as {@link MutationResult}'s conflict). Only ever returned
 * when the caller supplied a `baseVersion`.
 */
export interface CommitConflict {
  conflict: true
  currentVersion: string
}

/**
 * The result of a mutation guarded by optimistic concurrency.
 *
 * `conflict` carries the revision the record is actually at, never a verdict — the caller
 * compares it to what it expected, the same way `/api/specs/version` reports two numbers. When
 * the caller supplies no `expectedRev`, the write proceeds and only ever returns `ok` or
 * `not-found`; the conflict case appears only for a caller that opted into the check.
 */
export type MutationResult =
  | { ok: true; rev: number; at: StoredAt }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'conflict'; currentRev: number }

export interface SpecStore {
  /**
   * Who this glossary is — its display name and one-line domain. Glossary content, not
   * deployment config: the filesystem backend reads it from `specs/project.json`, a SQL backend
   * from a row, a hosted one per tenant. A missing or malformed source degrades to a neutral
   * default rather than throwing, the same way an unreadable record becomes a `problem`.
   */
  projectInfo(): Promise<ProjectInfo>

  /**
   * Set (or clear) the project's System Brief (GH #143) — the free-prose product framing that
   * `projectInfo()` returns and `sharedPrompt` injects. An empty string clears it. Name/domain are
   * unchanged. Not rev-guarded: project identity is a single small record, not a versioned one.
   */
  setProjectBrief(brief: string): Promise<void>

  // ── Reads ──────────────────────────────────────────────────────────────────────────
  // Partitioned by state, returning domain objects. No file handles.
  readTerms(): Promise<Glossary>
  readChangesets(): Promise<PendingChangesets>
  readQuestions(): Promise<QuestionFeed>
  readExpectations(): Promise<ExpectationFeed>
  readScenarios(): Promise<ScenarioFeed>

  findChangeset(id: string): Promise<Changeset | null>
  findQuestion(id: string): Promise<Question | null>
  findExpectation(id: string): Promise<Expectation | null>
  findScenario(id: string): Promise<Scenario | null>

  // ── Id allocation ──────────────────────────────────────────────────────────────────
  // Replaces uniquePath + the per-writer nextId scanners. The store owns id generation
  // because a SQL backend does it with a sequence/constraint, not by probing for a free
  // filename. Each counts the partitions that must not hand an id out twice.
  nextChangesetId(): Promise<string> // scans pending + applied + rejected
  nextQuestionId(): Promise<string>
  nextExpectationId(): Promise<string> // counts retired too
  nextScenarioId(): Promise<string>

  // ── Writes ─────────────────────────────────────────────────────────────────────────
  // Validated domain objects in; state transitions are explicit method names.
  addChangeset(changeset: Changeset): Promise<StoredAt> // enters pending
  addQuestion(question: Question): Promise<StoredAt>
  addExpectation(expectation: Expectation): Promise<StoredAt> // enters live
  addScenario(scenario: Scenario): Promise<StoredAt>

  /**
   * Atomic: reconcile terms to the post-image and move the changeset pending → applied. When
   * `application.baseVersion` is set, compare-and-swap on it — return a {@link CommitConflict}
   * (writing nothing) if the glossary has moved since. See GH #93.
   */
  commitApplication(application: CommitApplication): Promise<CommitResult | CommitConflict>
  /** Move a pending changeset to rejected. Returns where it landed, or null if none matched. */
  rejectChangeset(id: string): Promise<string | null>
  /** Record code written against an applied changeset. Where it lives, or null if none matched. */
  markImplemented(id: string, at: string): Promise<StoredAt | null>

  /**
   * Write an answer into an open question (open → answered), in place, bumping its rev. When
   * `expectedRev` is given and the question has moved past it, the write is refused as a conflict.
   */
  writeAnswer(questionId: string, answer: Answer, expectedRev?: number): Promise<MutationResult>

  /**
   * Set (or clear) a question's `blocking` flag in place, bumping its rev (GH #137) — the human
   * override over what @coder raised. `expectedRev` guards it, as above. An answered question is
   * left as-is by callers (blocking is moot once closed), but the store does not forbid it.
   */
  setQuestionBlocking(questionId: string, blocking: boolean, expectedRev?: number): Promise<MutationResult>

  /** Move a live expectation to retired (bumps its rev). `expectedRev` guards it, as above. */
  retireExpectation(id: string, retired: Expectation, expectedRev?: number): Promise<MutationResult>
  /** Rewrite a live expectation in place, bumping its rev — e.g. after a recheck or a publish. */
  rewriteExpectation(expectation: Expectation, expectedRev?: number): Promise<MutationResult>
}
