import { useState } from 'react'
import type { Coverage, CoveragePair, Expectation } from '@abseed/spectra-core'
import type { CheckReport, ExpectationDraft } from '../glossaryTransport.js'
import { FilterPills, toggled } from './FilterPills.js'
import { TermRef } from './TermRef.js'

interface CoveragePanelProps {
  coverage: Coverage
  expectations: Expectation[]
  known: Set<string>
  onSelectTerm: (name: string) => void
  onRaise: (draft: { terms: string[]; given: string; expect: string }, contested: CheckReport['findings']) => void
  /** Reads a draft against the glossary, writing nothing — supplied by the shell's transport. */
  onCheck: (draft: ExpectationDraft, superseding?: string) => Promise<CheckReport>
  busy: boolean
}

/**
 * What the glossary has named but nobody has said anything about.
 *
 * Uncovered is the default view for the same reason unanswered questions are: a gap is
 * something still waiting on you, and a covered pair is a thing already done. Covered pairs
 * stay one click away rather than competing for the screen.
 */
const DEFAULT_FILTERS = new Set(['gaps'])

/**
 * Deliberately no percentage.
 *
 * Coverage here means "has anyone said what should happen", not "is it correct" — five
 * expectations on a pair is five times someone thought about it, which a score would quietly
 * present as a quality measure. So this counts and lists, and leaves the judgement where
 * `/api/specs/version` leaves it: with the person reading two numbers.
 */
export function CoveragePanel({
  coverage,
  expectations,
  known,
  onSelectTerm,
  onRaise,
  onCheck,
  busy,
}: CoveragePanelProps) {
  const [filters, setFilters] = useState<ReadonlySet<string>>(DEFAULT_FILTERS)
  const [writingFor, setWritingFor] = useState<string | null>(null)

  const pairs = coverage.entities.flatMap((entry) => entry.pairs)
  const covered = pairs.filter((pair) => pair.expectations.length > 0)

  if (pairs.length === 0 && expectations.length === 0) return null

  const byId = new Map(expectations.map((expectation) => [expectation.id, expectation] as const))

  const shown = [
    ...(filters.has('gaps') ? coverage.gaps : []),
    ...(filters.has('covered') ? covered : []),
  ]

  return (
    <section className="coverage">
      <h2>
        Coverage
        <FilterPills
          active={filters}
          onToggle={(key) => setFilters((current) => toggled(current, key))}
          options={[
            {
              key: 'gaps',
              label: 'uncovered',
              count: coverage.gaps.length,
              tone: 'open',
              title: 'Pairs no expectation names both ends of',
            },
            { key: 'covered', label: 'covered', count: covered.length },
          ]}
        />
      </h2>

      <p className="muted coverage-legend">
        Each row pairs an <b>entity</b> with an <b>action</b> — a function or event — that touches it.
        E.g. <code>User × Event</code> asks <i>what should happen to a User when an Event is recorded</i>.
        A gap means no expectation says the outcome; use “say what should happen” to add one.{' '}
        <code>dN</code> is how far apart the two are in the term graph — <code>d1</code> is directly
        related; higher means reached through other terms, which is where gaps hide.
      </p>

      {coverage.contested.length > 0 && (
        <ul className="contested-list">
          {coverage.contested.map((entry) => (
            <li key={`${entry.expectation}.${entry.subject}`}>
              <code>{entry.expectation}</code> disagrees with{' '}
              <TermRef name={entry.subject} known={known} onSelect={onSelectTerm} /> and covers
              nothing until someone settles which side gives.
              {entry.quote && <q className="check-quote">{entry.quote}</q>}
            </li>
          ))}
        </ul>
      )}

      {coverage.dangling.length > 0 && (
        <ul className="problems">
          {coverage.dangling.map((entry) => (
            <li key={`${entry.expectation}.${entry.term}`}>
              <code>{entry.expectation}</code> names <code>{entry.term}</code>, which no term
              declares.
            </li>
          ))}
        </ul>
      )}

      {shown.length === 0 ? (
        <p className="muted empty-filter">
          {coverage.gaps.length === 0 ? 'Every pair has an expectation.' : 'Everything is filtered out.'}
        </p>
      ) : (
        <ul className="coverage-list">
          {shown.map((pair) => {
            const key = `${pair.entity}.${pair.action}`
            return (
              <PairRow
                key={key}
                pair={pair}
                byId={byId}
                known={known}
                onSelectTerm={onSelectTerm}
                writing={writingFor === key}
                onToggleWrite={() => setWritingFor(writingFor === key ? null : key)}
                onCheck={onCheck}
                onRaise={(given, expect, contested) => {
                  onRaise({ terms: [pair.entity, pair.action], given, expect }, contested)
                  setWritingFor(null)
                }}
                busy={busy}
              />
            )
          })}
        </ul>
      )}

      {coverage.nonFunctional.length > 0 && (
        <p className="muted coverage-nonfunctional">
          {coverage.nonFunctional.length} non-functional expectation
          {coverage.nonFunctional.length === 1 ? '' : 's'} — properties of a running build, so
          they belong to no pair and are never counted above:{' '}
          {coverage.nonFunctional.map((id) => (
            <code key={id}>{id} </code>
          ))}
        </p>
      )}
    </section>
  )
}

function PairRow({
  pair,
  byId,
  known,
  onSelectTerm,
  writing,
  onToggleWrite,
  onCheck,
  onRaise,
  busy,
}: {
  pair: CoveragePair
  byId: Map<string, Expectation>
  known: Set<string>
  onSelectTerm: (name: string) => void
  writing: boolean
  onToggleWrite: () => void
  onCheck: (draft: ExpectationDraft, superseding?: string) => Promise<CheckReport>
  onRaise: (given: string, expect: string, contested: CheckReport['findings']) => void
  busy: boolean
}) {
  const gap = pair.expectations.length === 0

  return (
    <li className={`coverage-row ${gap ? 'coverage-gap' : 'coverage-covered'} ${writing ? 'coverage-writing' : ''}`}>
      <div className="coverage-line">
        <span
          className={`distance distance-${pair.distance}`}
          title={
            pair.distance === 1
              ? 'The action names this entity directly'
              : `Reached through ${pair.distance - 1} step(s) of the entity graph — an interaction neither file mentions`
          }
        >
          d{pair.distance}
        </span>

        <span
          className="coverage-pair"
          title={
            gap
              ? `What happens to ${pair.entity} when ${pair.action} occurs? No expectation says.`
              : `What happens to ${pair.entity} when ${pair.action} occurs — covered by an expectation.`
          }
        >
          <TermRef name={pair.entity} known={known} onSelect={onSelectTerm} />
          <span className="muted"> × </span>
          <TermRef name={pair.action} known={known} onSelect={onSelectTerm} />
        </span>

        {gap ? (
          <span
            className="muted coverage-empty"
            title={`What happens to ${pair.entity} when ${pair.action} occurs? No expectation names both, so the outcome is unspecified — “say what should happen” to add one.`}
          >
            nothing says what should happen
          </span>
        ) : (
          <span className="coverage-ids">
            {pair.expectations.map((id) => (
              <code key={id} title={summarize(byId.get(id))}>
                {id}
              </code>
            ))}
          </span>
        )}

        <button type="button" className="coverage-write" onClick={onToggleWrite} disabled={busy}>
          {writing ? 'cancel' : gap ? 'say what should happen' : 'add another'}
        </button>
      </div>

      {writing && (
        <ExpectationFields
          terms={[pair.entity, pair.action]}
          submitLabel="Raise it"
          onCheck={onCheck}
          onSubmit={onRaise}
          busy={busy}
        />
      )}
    </li>
  )
}

/**
 * Given/expect, checked against the glossary before it can be written.
 *
 * The check is a gate rather than an annotation, and the reason is the one only the author
 * knows: "I just noticed something" is very often "I forgot what we already decided". Reading
 * the draft against the specs before it exists is what lets a contradiction be killed unborn
 * instead of superseded later — and superseding leaves a permanent artifact, which is right
 * for a rule that genuinely changed and pure noise for one that was never true.
 *
 * Editing after a check clears the verdict. A finding that survives on screen while the text
 * it described has changed underneath it is worse than no finding at all.
 *
 * `terms` is shown but not editable: it is prefilled from the pair being filled in, and an
 * expectation whose terms drift off the gap it was written for stops covering it, silently,
 * since coverage matches on names.
 */
export function ExpectationFields({
  terms,
  kind = 'functional',
  submitLabel,
  onCheck,
  onSubmit,
  busy,
  initialGiven = '',
  initialExpect = '',
  superseding,
}: {
  terms: string[]
  kind?: Expectation['kind']
  submitLabel: string
  /** Reads the draft against the glossary, writing nothing — supplied by the shell's transport. */
  onCheck: (draft: ExpectationDraft, superseding?: string) => Promise<CheckReport>
  onSubmit: (given: string, expect: string, contested: CheckReport['findings']) => void
  busy: boolean
  initialGiven?: string
  initialExpect?: string
  /** Id being replaced, left out of the duplicate comparison. */
  superseding?: string
}) {
  const [given, setGiven] = useState(initialGiven)
  const [expect, setExpect] = useState(initialExpect)
  const [report, setReport] = useState<CheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  // Any edit invalidates the verdict — it was about text that no longer exists.
  function edit(set: (value: string) => void) {
    return (event: { target: { value: string } }) => {
      set(event.target.value)
      setReport(null)
    }
  }

  async function check() {
    setChecking(true)
    try {
      setReport(
        await onCheck({ kind, terms, given: given.trim(), expect: expect.trim() }, superseding),
      )
    } catch (cause) {
      setReport({ findings: [], checked: false, note: (cause as Error).message })
    } finally {
      setChecking(false)
    }
  }

  const empty = expect.trim() === ''
  const blocked = busy || checking || empty
  const clashes = (report?.findings ?? []).filter(
    (finding) => finding.kind === 'contradicts' || finding.kind === 'duplicate',
  )

  return (
    <div className="expectation-form">
      <p className="muted expectation-form-terms">
        about {terms.map((term) => <code key={term}>{term} </code>)}
        <span className="expectation-form-hint">
          — phrase it in glossary words only; if you need to name a button, it is app work
        </span>
      </p>
      <label>
        <span className="muted">Given</span>
        <input
          value={given}
          onChange={edit(setGiven)}
          placeholder="the situation — leave empty if it always holds"
          disabled={busy}
        />
      </label>
      <label>
        <span className="muted">Expect</span>
        <input
          value={expect}
          onChange={edit(setExpect)}
          placeholder="what must happen"
          disabled={busy}
        />
      </label>

      {report && <CheckFindings report={report} />}

      <div className="expectation-actions">
        {report === null ? (
          <button type="button" className="action" disabled={blocked} onClick={() => void check()}>
            {checking ? 'Reading it against the specs…' : 'Check against the specs'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`action ${clashes.length > 0 ? 'action-warn' : ''}`}
              disabled={blocked}
              onClick={() => onSubmit(given.trim(), expect.trim(), report.findings)}
            >
              {clashes.length > 0 ? `${submitLabel} anyway` : submitLabel}
            </button>
            <button type="button" className="recheck" disabled={blocked} onClick={() => void check()}>
              check again
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Findings, ordered by how much they should change your mind.
 *
 * None of them refuse the write. A contradiction is often a legitimate thing to want that the
 * glossary does not allow yet — e-011 was exactly that — and refusing it would put a model in
 * charge of what you are allowed to expect from your own product. So it says what clashes,
 * quotes it, and leaves the button where it was.
 */
function CheckFindings({ report }: { report: CheckReport }) {
  if (report.findings.length === 0) {
    return (
      <p className={`check-verdict ${report.checked ? 'check-clear' : 'check-partial'}`}>
        {report.checked
          ? 'Nothing clashes — it adds something the specs do not already settle.'
          : `Nothing mechanical clashes. ${report.note ?? ''}`}
      </p>
    )
  }

  const rank: Record<string, number> = { contradicts: 0, duplicate: 1, 'unknown-term': 2, restates: 3, overlaps: 4 }
  const ordered = [...report.findings].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))

  return (
    <ul className="check-findings">
      {ordered.map((finding, index) => (
        <li key={`${finding.kind}.${finding.subject}.${index}`} className={`check-${finding.kind}`}>
          <span className="check-kind">{finding.kind}</span>
          <span className="check-detail">
            {finding.detail}
            {finding.quote && <q className="check-quote">{finding.quote}</q>}
          </span>
        </li>
      ))}
      {!report.checked && <li className="check-partial">{report.note}</li>}
    </ul>
  )
}

function summarize(expectation: Expectation | undefined): string {
  if (!expectation) return ''
  return expectation.given ? `Given ${expectation.given} — ${expectation.expect}` : expectation.expect
}
