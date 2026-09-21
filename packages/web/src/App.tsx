/**
 * The local tool's shell: pure view state (selection, filter, which changeset is open), the derived
 * glossary computations (backlinks, coverage, the changeset projection), and the layout.
 *
 * All the backend-touching behavior — bootstrap, project selection, the commit/answer/expectation
 * flows — lives in `useGlossary`, driven here with `apiTransport` (same-origin REST). A different host
 * would keep this file's shape but inject its own transport and lay the pieces out its own way; that
 * split is what a `web-lib` would draw the line along. The derived memos stay here because they are
 * pure functions of the loaded glossary and the selection — they need no backend at all.
 */
import { useCallback, useMemo, useState } from 'react'
import type { Changeset, Expectation, HighlightKind, Scenario, Term, TermType } from '@abseed/spectra-core'
import { computeBacklinks, computeCoverage, connectionsFor } from '@abseed/spectra-core'
import { apiTransport } from './api.js'
import { Diagram } from './Diagram.js'
import {
  ChangesetBar,
  ChangesetReview,
  ChatPanel,
  CoveragePanel,
  filterTerms,
  HighlightLegend,
  ProjectSwitcher,
  QuestionPanel,
  ScenarioPanel,
  reviewChangeset,
  SearchBar,
  TermDetail,
  TermList,
  useGlossary,
} from '@abseed/spectra-web-lib'
import type { Entity, SupersedeDraft } from '@abseed/spectra-web-lib'

const EMPTY_CONNECTIONS: Map<string, HighlightKind> = new Map()
const EMPTY_TERMS: Term[] = []
const EMPTY_CHANGESETS: Changeset[] = []
const EMPTY_EXPECTATIONS: Expectation[] = []
const EMPTY_SCENARIOS: Scenario[] = []

export function App() {
  const {
    project,
    orgs,
    projects,
    org,
    projectId,
    glossary,
    feed,
    questionFeed,
    expectationFeed,
    scenarioFeed,
    error,
    busy,
    notice,
    load,
    selectOrg,
    selectProject,
    commit,
    recordAnswer,
    raise,
    recheck,
    supersede,
  } = useGlossary(apiTransport)

  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<Set<TermType>>(new Set())

  const [openId, setOpenId] = useState<string | null>(null)
  const [selectedOps, setSelectedOps] = useState<Set<number>>(new Set())
  const [acknowledged, setAcknowledged] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [view, setView] = useState<'terms' | 'diagram'>('terms')

  const terms = glossary?.terms ?? EMPTY_TERMS
  const changesets = feed?.changesets ?? EMPTY_CHANGESETS
  const openChangeset = changesets.find((changeset) => changeset.id === openId) ?? null

  // STABLE across renders: ChatPanel keys its live-stream effect off this callback's identity, so a
  // fresh arrow would tear down and re-open the chat stream (clearing then reloading the thread) on
  // every App re-render — e.g. selecting a term. `load` is itself stable.
  const handleSpecsChanged = useCallback(() => void load(), [load])

  const review = useMemo(
    () => (openChangeset ? reviewChangeset(terms, openChangeset, selectedOps) : null),
    [terms, openChangeset, selectedOps],
  )

  // While a changeset is open the whole view renders against the projected glossary, so
  // backlinks, dangling refs and highlights all describe the world *after* the change.
  const projected = review ? review.projected : terms
  const backlinks = useMemo(() => computeBacklinks(projected), [projected])
  const known = useMemo(() => new Set(projected.map((term) => term.name)), [projected])

  // Terms the change removes stay in the list so the removal is visible and clickable.
  const display = useMemo(() => {
    if (!review) return terms
    const byName = new Map(review.projected.map((term) => [term.name, term] as const))
    for (const term of terms) if (!byName.has(term.name)) byName.set(term.name, term)
    return [...byName.values()]
  }, [terms, review])

  const displayByName = useMemo(
    () => new Map(display.map((term) => [term.name, term] as const)),
    [display],
  )
  const originalByName = useMemo(
    () => new Map(terms.map((term) => [term.name, term] as const)),
    [terms],
  )

  const expectations = expectationFeed?.expectations ?? EMPTY_EXPECTATIONS

  // Computed against `projected`, not `terms`. While a changeset is open the board describes
  // the glossary the change would leave behind — a proposal that adds a function shows its
  // uncovered pairs before anyone applies it, which is the same trick the highlights and
  // diagnostics already do.
  const coverage = useMemo(
    () => computeCoverage(projected, expectations),
    [projected, expectations],
  )

  const connections = useMemo(
    () => (selected ? connectionsFor(backlinks, selected) : EMPTY_CONNECTIONS),
    [backlinks, selected],
  )
  const visible = useMemo(() => filterTerms(display, query, types), [display, query, types])

  // What `@` completes over: the vocabulary itself, not files.
  const entities = useMemo<Entity[]>(
    () => [
      ...terms.map((term) => ({ name: term.name, kind: 'term' as const, hint: term.type })),
      ...(questionFeed?.questions ?? []).map((question) => ({
        name: question.id,
        kind: 'question' as const,
        hint: question.answer ? 'answered' : 'open',
      })),
      ...changesets.map((changeset) => ({
        name: changeset.id,
        kind: 'changeset' as const,
        hint: changeset.summary.slice(0, 40),
      })),
      ...expectations.map((expectation) => ({
        name: expectation.id,
        kind: 'expectation' as const,
        hint: expectation.expect.slice(0, 40),
      })),
    ],
    [terms, questionFeed, changesets, expectations],
  )

  function toggleType(type: TermType) {
    setTypes((current) => {
      const next = new Set(current)
      if (!next.delete(type)) next.add(type)
      return next
    })
  }

  function openReview(changeset: Changeset) {
    setOpenId(changeset.id)
    setSelectedOps(new Set(changeset.ops.map((_, index) => index)))
    setAcknowledged(false)
  }

  function closeReview() {
    setOpenId(null)
    setSelectedOps(new Set())
    setAcknowledged(false)
  }

  function toggleOp(index: number) {
    setSelectedOps((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  function setAllOps(all: boolean) {
    setSelectedOps(all ? new Set((openChangeset?.ops ?? []).map((_, index) => index)) : new Set())
  }

  if (error) return <p className="error">Could not load the glossary: {error}</p>
  if (!glossary || !feed || !questionFeed || !expectationFeed)
    return <p className="muted empty">Loading…</p>

  const selectedTerm = selected ? displayByName.get(selected) : undefined
  const status = selected ? review?.statuses.get(selected) : undefined
  const detailReview =
    status && selected ? { previous: originalByName.get(selected) ?? null, status } : undefined

  const problems = [
    ...glossary.problems,
    ...feed.problems,
    ...questionFeed.problems,
    ...expectationFeed.problems,
  ]

  return (
    <div className={`app ${chatOpen ? 'app-with-chat' : ''}`}>
      <div className="app-main">
      <header className="app-header">
        <h1>{project?.name ?? 'Spectra'}</h1>
        <ProjectSwitcher
          orgs={orgs}
          projects={projects}
          org={org}
          projectId={projectId}
          onOrg={selectOrg}
          onProject={selectProject}
        />
        <span className="muted">spec glossary</span>
        <HighlightLegend />
        <button
          type="button"
          className="action"
          aria-pressed={view === 'diagram'}
          onClick={() => setView((current) => (current === 'terms' ? 'diagram' : 'terms'))}
        >
          {view === 'terms' ? 'Diagram' : 'Terms'}
        </button>
        {!chatOpen && (
          <button type="button" className="action chat-open" onClick={() => setChatOpen(true)}>
            Chat
          </button>
        )}
      </header>

      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((problem) => (
            <li key={problem.file}>
              <code>{problem.file}</code> — {problem.message}
            </li>
          ))}
        </ul>
      )}

      {notice && <p className={`notice notice-${notice.tone}`}>{notice.message}</p>}

      <QuestionPanel
        questions={questionFeed.questions}
        known={known}
        onSelectTerm={setSelected}
        onAnswer={recordAnswer}
        busy={busy}
      />

      <CoveragePanel
        coverage={coverage}
        expectations={expectations}
        known={known}
        onSelectTerm={setSelected}
        onRaise={raise}
        onCheck={apiTransport.checkExpectation}
        busy={busy}
      />

      <ScenarioPanel
        scenarios={scenarioFeed?.scenarios ?? EMPTY_SCENARIOS}
        known={known}
        onSelectTerm={setSelected}
      />

      <ChangesetBar
        changesets={changesets}
        applied={feed.applied}
        rejected={feed.rejected}
        openId={openId}
        busy={busy}
        onImplemented={(id) => commit(() => apiTransport.markImplemented(id), closeReview)}
        onToggle={(changeset) => (changeset.id === openId ? closeReview() : openReview(changeset))}
        renderReview={(changeset) =>
          review && (
            <ChangesetReview
              changeset={changeset}
              review={review}
              selectedOps={selectedOps}
              onToggleOp={toggleOp}
              onSetAllOps={setAllOps}
              onSelectTerm={setSelected}
              onClose={closeReview}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
              onApply={() =>
                commit(() => apiTransport.applyChangeset(changeset.id, [...selectedOps], acknowledged, glossary.version), closeReview)
              }
              onReject={() => commit(() => apiTransport.rejectChangeset(changeset.id), closeReview)}
              busy={busy}
            />
          )
        }
      />

      {view === 'diagram' ? (
        <div className="panes">
          <div className="pane pane-diagram">
            <Diagram terms={display} expectations={expectations} onSelectTerm={setSelected} />
          </div>
          {selectedTerm ? (
            <div className="pane pane-detail" style={{ flex: '0 0 380px', borderLeft: '1px solid var(--line)', overflow: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="muted">Selected term</span>
                <button type="button" className="action" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <TermDetail
                term={selectedTerm}
                termsByName={displayByName}
                backlinks={backlinks}
                known={known}
                onSelect={setSelected}
                review={detailReview}
                expectations={expectations}
                coverage={coverage}
                onSupersede={(id: string, draft: SupersedeDraft) => supersede(id, draft)}
                onRecheck={recheck}
                onCheck={apiTransport.checkExpectation}
                busy={busy}
              />
            </div>
          ) : null}
        </div>
      ) : (
      <div className="panes">
        <div className="pane pane-list">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            types={types}
            onToggleType={toggleType}
            shown={visible.length}
            total={display.length}
          />
          <TermList
            terms={visible}
            selected={selected}
            connections={connections}
            statuses={review?.statuses}
            onSelect={setSelected}
          />
        </div>

        <div className="pane pane-detail">
          {selectedTerm ? (
            <TermDetail
              term={selectedTerm}
              termsByName={displayByName}
              backlinks={backlinks}
              known={known}
              onSelect={setSelected}
              review={detailReview}
              expectations={expectations}
              coverage={coverage}
              onSupersede={(id: string, draft: SupersedeDraft) => supersede(id, draft)}
              onRecheck={recheck}
              onCheck={apiTransport.checkExpectation}
              busy={busy}
            />
          ) : (
            <p className="muted empty">Pick a term to see its spec, attributes and backlinks.</p>
          )}
        </div>
      </div>
      )}
      </div>

      {chatOpen && (
        <ChatPanel
          entities={entities}
          onSpecsChanged={handleSpecsChanged}
          onSelectTerm={setSelected}
          onClose={() => setChatOpen(false)}
          // Persist the unsent draft per project, so a reload/timeout mid-typing doesn't lose it.
          draftKey={projectId ? `${org ?? 'local'}/${projectId}` : undefined}
        />
      )}
    </div>
  )
}
