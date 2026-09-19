/**
 * Writing scenarios, over the {@link SpecStore} seam.
 *
 * Governed like {@link raiseExpectation} and `raiseQuestion`: **adding is free.** A scenario names
 * a situation and asserts an outcome; it changes no term and cannot alter what the app does — the
 * most it can do is fail, which reveals a gap rather than hiding one. So it is raised, not proposed
 * through a changeset. (Superseding a scenario — the reviewed move — is a later slice; v1 is
 * add-only.)
 *
 * Pure and validated-before-disk, so it lives in core beside the seam: every coordinator raises
 * scenarios identically.
 */
import { parseScenario } from './schema.js'
import type { Author, Scenario } from './types.js'
import type { SpecStore } from './specStore.js'

export interface RaiseScenarioRequest {
  title: string
  /** Every term the scenario touches — cross-entity by nature; at least one. */
  terms: string[]
  /** The setup, if there is one. */
  given?: string
  /** Ordered steps; simultaneity is stated in the prose (v1). */
  steps?: string[]
  /** What must hold — at least one assertion. */
  expect: string[]
  /** What was being done when it came up, e.g. `implementation` or `usage`. */
  pass: string
  from?: string
  file?: string
}

export type ScenarioOutcome =
  | { ok: false; error: string; status?: number }
  | { ok: true; id: string; file: string; scenario: Scenario }

export async function raiseScenario(
  store: SpecStore,
  request: RaiseScenarioRequest,
  author: Author,
): Promise<ScenarioOutcome> {
  const id = await store.nextScenarioId()

  const scenario: Scenario = {
    id,
    title: request.title,
    author,
    terms: request.terms,
    given: request.given ?? '',
    steps: request.steps ?? [],
    expect: request.expect,
    raisedBy: {
      pass: request.pass,
      ...(request.from ? { from: request.from } : {}),
      ...(request.file ? { file: request.file } : {}),
    },
  }

  // Validated before it reaches disk, not after — an invalid scenario would otherwise come back
  // as a source problem in the UI instead of an error the caller can act on.
  const parsed = parseScenario(scenario)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; '), status: 400 }

  const file = await store.addScenario(scenario)
  return { ok: true, id, file, scenario }
}
