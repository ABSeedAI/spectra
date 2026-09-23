/**
 * The seam that makes the glossary *behavior* portable: the data contracts and the operations the UI
 * performs, as an interface — not as `fetch` calls.
 *
 * `useGlossary` (the orchestration: loading, the commit/answer/expectation flows) depends on this
 * interface and nothing else, so the same behavior runs against any backend that implements it. The
 * local tool implements it with same-origin REST (`apiTransport` in `api.ts`); a different host — one
 * that drives the agents over its own wire — implements it its own way and reuses the identical hook.
 *
 * This is deliberately the *glossary* transport, not the chat one: chat has its own injected seam
 * (`setChatTransport` in `chat.ts`). Keeping the two apart is what lets a host swap either without the
 * other. The types here are the published contract, so they live beside the interface rather than in
 * the REST module that happens to implement it today.
 */
import type {
  Answer,
  Changeset,
  Diagnostic,
  Expectation,
  ProjectInfo,
  Question,
  Scenario,
  SourceProblem,
  Term,
} from '@abseed/spectra-core'

export interface Context {
  org: string
  projectId: string
  project: ProjectInfo
}

export interface Org {
  id: string
  name: string
}

export interface ProjectSummary {
  id: string
  name: string
  domain: string
}

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
  /**
   * A content token for the glossary (optimistic concurrency). A host that supplies it can pass it
   * back as `applyChangeset`'s `expectedVersion`, so a changeset reviewed against a since-moved
   * glossary is refused (`CommitOutcome.staleVersion`) rather than clobbering. Absent when the backend
   * does not report one — the guard is simply not engaged.
   */
  version?: string
}

export interface ChangesetFeed {
  changesets: Changeset[]
  problems: SourceProblem[]
  /** Resolved changesets, newest first, from changesets/applied and changesets/rejected. */
  applied: Changeset[]
  rejected: Changeset[]
}

export interface QuestionFeed {
  questions: Question[]
  problems: SourceProblem[]
}

export interface ExpectationFeed {
  expectations: Expectation[]
  /** Superseded, kept so a citation of an old id still resolves. */
  retired: Expectation[]
  problems: SourceProblem[]
}

export interface ScenarioFeed {
  scenarios: Scenario[]
  problems: SourceProblem[]
}

export interface CommitOutcome {
  ok: boolean
  error?: string
  diagnostics?: Diagnostic[]
  needsAcknowledgement?: boolean
  /**
   * The glossary moved since this changeset was reviewed (optimistic concurrency): nothing was
   * written, and the review should be redone against the current glossary. `currentVersion` is where
   * it is now. Distinct from a diagnostics refusal — the ops are fine, the world changed.
   */
  staleVersion?: boolean
  currentVersion?: string
  appliedOps?: number
  remainingOps?: number
  written?: string[]
  deleted?: string[]
  resolvedTo?: string
}

export interface AnswerOutcome extends CommitOutcome {
  questionId?: string
  answer?: Answer
  changesetId?: string
  changesetFile?: string
}

export interface RaiseOutcome {
  ok: boolean
  error?: string
  id?: string
  file?: string
  expectation?: Expectation
}

export interface ExpectationDraft {
  kind: Expectation['kind']
  terms: string[]
  given: string
  expect: string
}

export interface CheckReport {
  findings: Array<{ kind: string; subject: string; detail: string; quote?: string }>
  /** False when the semantic pass did not run — no credential, or it failed. */
  checked: boolean
  note?: string
}

export interface SupersedeOutcome {
  ok: boolean
  error?: string
  retired?: string
  replacement?: Expectation | null
}

/**
 * Everything `useGlossary` asks of a backend. An implementation is a bag of async calls plus the one
 * synchronous `configureProject` (it only sets the prefix later calls carry). Reads never throw for a
 * refused write — a 409 comes back as `{ ok: false }` data, per `CommitOutcome`.
 */
export interface GlossaryTransport {
  /** Un-prefixed bootstrap reads — which org/project this UI is for, and what it may pick from. */
  fetchContext(): Promise<Context>
  fetchOrgs(): Promise<{ orgs: Org[] }>
  fetchProjects(org: string): Promise<{ projects: ProjectSummary[] }>
  /** Point subsequent glossary calls at a project. Synchronous: it only sets the prefix. */
  configureProject(org: string, projectId: string): void

  /** The current project's full identity, incl. the System Brief (#143). Optional: a host without it keeps the list-summary identity. */
  fetchProject?(): Promise<Context['project']>
  fetchGlossary(): Promise<Glossary>
  fetchChangesets(): Promise<ChangesetFeed>
  fetchQuestions(): Promise<QuestionFeed>
  fetchExpectations(): Promise<ExpectationFeed>
  fetchScenarios(): Promise<ScenarioFeed>

  /**
   * `expectedVersion` (optional) is the {@link Glossary.version} the change was reviewed against; when
   * it no longer matches, the backend refuses with `CommitOutcome.staleVersion` and writes nothing.
   */
  applyChangeset(id: string, opIndices: number[], acknowledgeWarnings: boolean, expectedVersion?: string): Promise<CommitOutcome>
  markImplemented(id: string): Promise<CommitOutcome>
  rejectChangeset(id: string): Promise<CommitOutcome>

  answerQuestion(id: string, chose: string | null, note: string): Promise<AnswerOutcome>
  /** Human override of a question's blocking flag (GH #137). Optional: a host that does not support it leaves it unset. */
  setQuestionBlocking?(id: string, blocking: boolean): Promise<CommitOutcome>
  /** Set (or clear) the System Brief (GH #143), returning the updated identity. Optional: unset when unsupported. */
  setProjectBrief?(brief: string): Promise<Context['project']>

  checkExpectation(draft: ExpectationDraft, superseding?: string): Promise<CheckReport>
  raiseExpectation(draft: ExpectationDraft, contested?: CheckReport['findings']): Promise<RaiseOutcome>
  recheckExpectation(id: string): Promise<RaiseOutcome>
  supersedeExpectation(id: string, note: string, replacement: ExpectationDraft | null): Promise<SupersedeOutcome>
}
