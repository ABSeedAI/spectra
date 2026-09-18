/**
 * The drift check itself — "do the glossary and the code still agree?" — as pure findings.
 *
 * Kept framework-agnostic on purpose: it returns a list of problems rather than asserting, so a
 * consumer project turns it into a one-line test in whatever runner it already uses (see the README).
 * Empty list means the code and the committed snapshot are in sync.
 *
 * It checks two correspondences, symmetrically:
 *
 * - **Terms ↔ code.** A malformed `implements:` marker, a marker naming a term the glossary no longer
 *   has, and a term (entity/function/event) nothing implements.
 * - **Expectations ↔ tests (GH #96).** A malformed `verifies:` marker, a marker naming an expectation
 *   the glossary no longer has, and a *functional* expectation no test verifies. Non-functional
 *   expectations are exempt — they are properties of a running build, checked by driving it, not by a
 *   test phrased in glossary vocabulary.
 *
 * What it deliberately cannot catch: a term whose *spec was rewritten*, or an expectation whose
 * *wording changed* — the marker still names it and still looks right. That is what the per-term and
 * per-expectation `hash` in the snapshot is for: refreshing the file makes `git diff
 * specs.snapshot.json` name what moved, so the check fails loud for structure and review catches the
 * rest.
 */
import { existsSync } from 'node:fs'
import { implementersOf, readMarkers, readSnapshot, readVerifyMarkers } from './implements.js'
import type { Marker, Snapshot, VerifyMarker } from './implements.js'

export type DriftFindingKind =
  | 'no-snapshot'
  | 'no-markers'
  | 'malformed-marker'
  | 'unknown-term'
  | 'unimplemented-term'
  | 'unknown-expectation'
  | 'unverified-expectation'

export interface DriftFinding {
  kind: DriftFindingKind
  message: string
}

/** Terms that must be implemented by code. attribute-types are value shapes carried by other terms. */
const NEEDS_IMPLEMENTING = new Set(['entity', 'function', 'event'])

/**
 * Compare markers against a snapshot. A null snapshot is itself the finding — a missing committed
 * file, not a missing service, so it fails hard rather than skipping (a green run that checked
 * nothing is the outcome worth refusing).
 */
export function checkDrift(
  markers: Marker[],
  snapshot: Snapshot | null,
  verifyMarkers: VerifyMarker[] = [],
): DriftFinding[] {
  if (!snapshot) {
    return [{ kind: 'no-snapshot', message: 'No specs.snapshot.json — run export_specs and commit the result.' }]
  }

  const findings: DriftFinding[] = []

  if (markers.length === 0) {
    findings.push({ kind: 'no-markers', message: 'No `// implements:` markers found under the scanned directory.' })
  }

  for (const marker of markers) {
    if (marker.malformed.length > 0) {
      findings.push({
        kind: 'malformed-marker',
        message: `${marker.file}:${marker.line} — not bare identifiers: ${marker.malformed.join(', ')} (put prose on the next line)`,
      })
    }
  }

  const known = new Set(snapshot.terms.map((term) => term.name))
  for (const marker of markers) {
    for (const term of marker.terms) {
      if (!known.has(term)) {
        findings.push({ kind: 'unknown-term', message: `${marker.file}:${marker.line} — marker names "${term}", not in the glossary (renamed or removed?)` })
      }
    }
  }

  const implementers = implementersOf(markers)
  for (const term of snapshot.terms) {
    if (NEEDS_IMPLEMENTING.has(term.type) && !implementers.has(term.name)) {
      findings.push({ kind: 'unimplemented-term', message: `${term.name} (${term.type}) — nothing implements it; an implementation pass is due` })
    }
  }

  // Expectations ↔ tests. A snapshot exported before expectations existed has none, so this is a
  // no-op there; the field is optional for exactly that reason.
  const expectations = snapshot.expectations ?? []
  const knownExpectations = new Set(expectations.map((expectation) => expectation.id))

  for (const marker of verifyMarkers) {
    if (marker.malformed.length > 0) {
      findings.push({
        kind: 'malformed-marker',
        message: `${marker.file}:${marker.line} — not expectation ids: ${marker.malformed.join(', ')} (a verifies: marker names ids like e-001; put prose on the next line)`,
      })
    }
    for (const id of marker.ids) {
      if (!knownExpectations.has(id)) {
        findings.push({ kind: 'unknown-expectation', message: `${marker.file}:${marker.line} — verifies "${id}", not a live expectation in the glossary (renamed, retired, or a typo)` })
      }
    }
  }

  const verified = new Set(verifyMarkers.flatMap((marker) => marker.ids))
  for (const expectation of expectations) {
    // Only functional expectations become an example test that a // verifies: marker names. A
    // non-functional one is a property of a build; an invariant verifies as a property over all
    // states (the verify-loop's job, not a single marker) — so both are exempt from this check.
    if (expectation.kind === 'functional' && !verified.has(expectation.id)) {
      findings.push({ kind: 'unverified-expectation', message: `${expectation.id} (functional) — no // verifies: marker; nothing tests that the code satisfies it` })
    }
  }

  return findings
}

/**
 * Read markers from `srcDir` and the snapshot at `snapshotPath`, and run the check. The convenience
 * a consumer project's test calls: `const { ok, findings } = driftCheck({ srcDir, snapshotPath })`.
 * `// verifies:` markers are read from the same tree (including its test files).
 */
export function driftCheck(opts: { srcDir: string; snapshotPath: string }): { ok: boolean; findings: DriftFinding[] } {
  const markers = readMarkers(opts.srcDir)
  const verifyMarkers = readVerifyMarkers(opts.srcDir)
  const snapshot = existsSync(opts.snapshotPath) ? readSnapshot(opts.snapshotPath) : null
  const findings = checkDrift(markers, snapshot, verifyMarkers)
  return { ok: findings.length === 0, findings }
}
