/**
 * The local tool's `GlossaryTransport`: same-origin REST against the API the spec server serves.
 *
 * The data contracts live in `@abseed/spectra-web-lib` (the reusable seam) and are re-exported here, so
 * existing imports from `./api.js` keep resolving. This module is just one *implementation* of that
 * seam — `apiTransport` bundles the calls into the object `useGlossary` (and any host shell) drives.
 */
import type {
  AnswerOutcome,
  ChangesetFeed,
  CheckReport,
  CommitOutcome,
  Context,
  ExpectationDraft,
  ExpectationFeed,
  Glossary,
  GlossaryTransport,
  Org,
  ProjectSummary,
  QuestionFeed,
  RaiseOutcome,
  ScenarioFeed,
  SupersedeOutcome,
} from '@abseed/spectra-web-lib'

// The project prefix lives in the lib's apiBase; configureProject is re-exported so callers still import
// it from here. fetchContext stays the un-prefixed bootstrap that tells the browser which org/project.
import { apiPath, configureProject } from '@abseed/spectra-web-lib'
export { configureProject }
export type {
  AnswerOutcome,
  ChangesetFeed,
  CheckReport,
  CommitOutcome,
  Context,
  ExpectationDraft,
  ExpectationFeed,
  Glossary,
  Org,
  ProjectSummary,
  QuestionFeed,
  RaiseOutcome,
  ScenarioFeed,
  SupersedeOutcome,
} from '@abseed/spectra-web-lib'

/** Read once at startup, before any glossary call, to learn which org/project this UI is for. */
export function fetchContext(): Promise<Context> {
  return get<Context>('/api/context')
}

/** The orgs this caller may pick from — the org selector's source. Un-prefixed, like the context. */
export function fetchOrgs(): Promise<{ orgs: Org[] }> {
  return get<{ orgs: Org[] }>('/api/orgs')
}

/** The projects in an org this caller may open — the project selector's source. */
export function fetchProjects(org: string): Promise<{ projects: ProjectSummary[] }> {
  return get<{ projects: ProjectSummary[] }>(`/api/orgs/${encodeURIComponent(org)}/projects`)
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} — ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export function fetchGlossary(): Promise<Glossary> {
  return get<Glossary>(apiPath(`/terms`))
}

export function fetchChangesets(): Promise<ChangesetFeed> {
  return get<ChangesetFeed>(apiPath(`/changesets`))
}

export function fetchQuestions(): Promise<QuestionFeed> {
  return get<QuestionFeed>(apiPath(`/questions`))
}

/**
 * Only the expectations are fetched, never the coverage — that is computed in the browser
 * from the same `computeCoverage` the server and the agents use.
 *
 * Not a saving. It is what lets the board describe the glossary *as a changeset would leave
 * it*: open a proposal that adds a function and its uncovered pairs appear immediately,
 * alongside the highlights and diagnostics that already work that way. A server-computed
 * number could only ever describe the world before the change.
 */
export function fetchExpectations(): Promise<ExpectationFeed> {
  return get<ExpectationFeed>(apiPath(`/expectations`))
}

/** The stored scenarios — cross-entity spec-level test cases. Read-only in the UI for now. */
export function fetchScenarios(): Promise<ScenarioFeed> {
  return get<ScenarioFeed>(apiPath(`/scenarios`))
}

/** A refused commit (409) is an expected answer, not a transport failure — it comes back as data. */
async function post<T = CommitOutcome>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    return (await response.json()) as T
  } catch {
    return { ok: false, error: `${url} — ${response.status} ${response.statusText}` } as T
  }
}

export function applyChangeset(
  id: string,
  opIndices: number[],
  acknowledgeWarnings: boolean,
  expectedVersion?: string,
): Promise<CommitOutcome> {
  return post(apiPath(`/changesets/${encodeURIComponent(id)}/apply`), {
    opIndices,
    acknowledgeWarnings,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  })
}

/** Records that code has been written for an applied changeset. */
export function markImplemented(id: string): Promise<CommitOutcome> {
  return post(apiPath(`/changesets/${encodeURIComponent(id)}/implemented`), {})
}

export function rejectChangeset(id: string): Promise<CommitOutcome> {
  return post(apiPath(`/changesets/${encodeURIComponent(id)}/reject`), {})
}

export function answerQuestion(id: string, chose: string | null, note: string): Promise<AnswerOutcome> {
  return post(apiPath(`/questions/${encodeURIComponent(id)}/answer`), { chose, note })
}

/**
 * Reads a draft against the glossary and writes nothing, so a bad one can be killed unborn.
 *
 * `superseding` names the expectation being replaced, which is then left out of the
 * comparison — a replacement is prefilled from its original, so without this every supersede
 * would report a duplicate of the thing it is retiring.
 */
export function checkExpectation(
  draft: ExpectationDraft,
  superseding?: string,
): Promise<CheckReport> {
  return post<CheckReport>(apiPath(`/expectations/check`), {
    ...draft,
    ...(superseding ? { superseding } : {}),
  })
}

/**
 * `contested` is what the check found and the author went ahead regardless.
 *
 * Sending it is the whole reason the gate is worth having. Without it the finding lives only
 * in the browser for the second before the click, and the expectation lands looking exactly
 * like one that came back clean — so nothing downstream, human or agent, can tell that the
 * glossary disagrees with it.
 */
export function raiseExpectation(
  draft: ExpectationDraft,
  contested: CheckReport['findings'] = [],
): Promise<RaiseOutcome> {
  return post<RaiseOutcome>(apiPath(`/expectations`), { ...draft, pass: 'usage', contested })
}

/** Re-reads a live expectation against the specs as they are now, and rewrites its clashes. */
export function recheckExpectation(id: string): Promise<RaiseOutcome> {
  return post<RaiseOutcome>(apiPath(`/expectations/${encodeURIComponent(id)}/recheck`), {})
}

/**
 * Retiring, optionally replacing. `note` is mandatory server-side, because an expectation
 * that stopped applying without a recorded reason is indistinguishable from one somebody
 * deleted to make a test pass.
 */
export function supersedeExpectation(
  id: string,
  note: string,
  replacement: ExpectationDraft | null,
): Promise<SupersedeOutcome> {
  return post<SupersedeOutcome>(apiPath(`/expectations/${encodeURIComponent(id)}/supersede`), {
    note,
    ...(replacement ? { replacement } : {}),
  })
}

/**
 * The local tool as a `GlossaryTransport`. This is the object the shell injects into `useGlossary`; a
 * different host swaps this one object and reuses every flow unchanged.
 */
export const apiTransport: GlossaryTransport = {
  fetchContext,
  fetchOrgs,
  fetchProjects,
  configureProject,
  fetchGlossary,
  fetchChangesets,
  fetchQuestions,
  fetchExpectations,
  fetchScenarios,
  applyChangeset,
  markImplemented,
  rejectChangeset,
  answerQuestion,
  checkExpectation,
  raiseExpectation,
  recheckExpectation,
  supersedeExpectation,
}
