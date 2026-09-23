/**
 * The glossary *behavior*, lifted out of the view: bootstrap, org/project selection, loading, and the
 * commit / answer / expectation flows — everything that talks to a backend and reports what came back.
 *
 * It depends only on the `GlossaryTransport` interface, never on a concrete `fetch` — that is the whole
 * point. A shell renders however it likes and drives this hook; the local tool injects `apiTransport`,
 * a different host injects its own. What stays in the shell is pure view state (which term is selected,
 * the filter, which changeset is open) and the derived glossary computations, which need no backend.
 *
 * The one place behavior touches the view is `commit`, which closes an open review on success — so it
 * takes an `onSuccess` callback the shell supplies, rather than reaching into view state it does not own.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProjectInfo } from '@abseed/spectra-core'
import type {
  AnswerOutcome,
  ChangesetFeed,
  CommitOutcome,
  ExpectationDraft,
  ExpectationFeed,
  Glossary,
  GlossaryTransport,
  Org,
  ProjectSummary,
  QuestionFeed,
  ScenarioFeed,
} from './glossaryTransport.js'

export interface Notice {
  tone: 'ok' | 'bad'
  message: string
}

const LAST_ORG = 'spectra.org'
const LAST_PROJECT = 'spectra.projectId'

// localStorage remembers the last-picked org/project so a reload returns you where you were.
// Wrapped because it throws in a private window or with site data blocked — a convenience, never
// load-bearing (the server's /api/context default covers a first visit or a cleared store).
const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // no-op: remembering the selection is a nicety, not a requirement
  }
}

/** First preference that actually exists in `available`, else the first available, else null. */
const pick = (available: string[], ...preferences: Array<string | null | undefined>): string | null => {
  for (const preference of preferences) {
    if (preference && available.includes(preference)) return preference
  }
  return available[0] ?? null
}

export function useGlossary(transport: GlossaryTransport) {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [org, setOrg] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [glossary, setGlossary] = useState<Glossary | null>(null)
  const [feed, setFeed] = useState<ChangesetFeed | null>(null)
  const [questionFeed, setQuestionFeed] = useState<QuestionFeed | null>(null)
  const [expectationFeed, setExpectationFeed] = useState<ExpectationFeed | null>(null)
  const [scenarioFeed, setScenarioFeed] = useState<ScenarioFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const load = useCallback(async () => {
    const [nextGlossary, nextFeed, nextQuestions, nextExpectations, nextScenarios] = await Promise.all([
      transport.fetchGlossary(),
      transport.fetchChangesets(),
      transport.fetchQuestions(),
      transport.fetchExpectations(),
      transport.fetchScenarios(),
    ])
    setGlossary(nextGlossary)
    setFeed(nextFeed)
    setQuestionFeed(nextQuestions)
    setExpectationFeed(nextExpectations)
    setScenarioFeed(nextScenarios)
  }, [transport])

  // Point the API at a project, remember the choice, show its identity, and load its glossary. Every
  // glossary call lives under the project's prefix, so configuring first is what makes them resolve.
  const openProject = useCallback(
    async (nextOrg: string, nextProjectId: string, inOrg: ProjectSummary[]) => {
      transport.configureProject(nextOrg, nextProjectId)
      setOrg(nextOrg)
      setProjectId(nextProjectId)
      remember(LAST_ORG, nextOrg)
      remember(LAST_PROJECT, nextProjectId)
      const info = inOrg.find((entry) => entry.id === nextProjectId)
      if (info) setProject({ name: info.name, domain: info.domain })
      await load()
      // Upgrade the summary-based identity to the full one, which carries the System Brief (#143).
      // Optional on the transport; keep the summary if it can't.
      if (transport.fetchProject) {
        try {
          setProject(await transport.fetchProject())
        } catch {
          /* keep the summary identity */
        }
      }
    },
    [load, transport],
  )

  // Switch org: fetch its projects, then open the remembered one (or the first). Its projects become
  // the project selector's options.
  const openOrg = useCallback(
    async (nextOrg: string, preferProjectId?: string) => {
      const { projects: inOrg } = await transport.fetchProjects(nextOrg)
      setProjects(inOrg)
      const chosen = pick(inOrg.map((entry) => entry.id), preferProjectId, recall(LAST_PROJECT))
      if (chosen) await openProject(nextOrg, chosen, inOrg)
    },
    [openProject, transport],
  )

  // A shell convenience: pick a project within the already-open org, catching to `error` like the
  // bootstrap does. The org selector's handler and the project selector's map to these two.
  const selectOrg = useCallback(
    (nextOrg: string) => void openOrg(nextOrg).catch((cause: Error) => setError(cause.message)),
    [openOrg],
  )
  const selectProject = useCallback(
    (nextProjectId: string) => {
      if (org) void openProject(org, nextProjectId, projects).catch((cause: Error) => setError(cause.message))
    },
    [openProject, org, projects],
  )

  // Bootstrap: the orgs to pick from and the server's default scope (un-prefixed, before any project
  // is configured). Open the remembered org (or the default, or the only one), which opens a project
  // and loads. A single org/project just auto-selects — the picker never makes you choose the only one.
  useEffect(() => {
    Promise.all([transport.fetchOrgs(), transport.fetchContext()])
      .then(async ([{ orgs: available }, context]) => {
        setOrgs(available)
        const chosenOrg = pick(available.map((entry) => entry.id), recall(LAST_ORG), context.org)
        if (chosenOrg) await openOrg(chosenOrg, recall(LAST_PROJECT) ?? context.projectId)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [openOrg, transport])

  const commit = useCallback(
    async (action: () => Promise<CommitOutcome>, onSuccess?: () => void) => {
      setBusy(true)
      setNotice(null)
      try {
        const outcome = await action()
        if (!outcome.ok) {
          // The glossary moved since this was reviewed (optimistic concurrency): nothing was written.
          // Reload so the view shows the current state, and say why — the review has to be redone.
          if (outcome.staleVersion) {
            setNotice({ tone: 'bad', message: 'The glossary changed since you opened this — reloaded to the current state. Re-check the change before applying.' })
            await load()
            return
          }
          setNotice({ tone: 'bad', message: outcome.error ?? 'The change was refused.' })
          return
        }

        const parts: string[] = []
        if (outcome.appliedOps) parts.push(`applied ${outcome.appliedOps} op(s)`)
        if (outcome.written?.length) parts.push(`wrote ${outcome.written.join(', ')}`)
        if (outcome.deleted?.length) parts.push(`deleted ${outcome.deleted.join(', ')}`)
        if (outcome.remainingOps) parts.push(`${outcome.remainingOps} op(s) still pending`)
        parts.push(`changeset now at changesets/${outcome.resolvedTo}`)

        setNotice({ tone: 'ok', message: parts.join(' · ') })
        onSuccess?.()
        await load()
      } catch (cause) {
        setNotice({ tone: 'bad', message: (cause as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const recordAnswer = useCallback(
    async (id: string, chose: string | null, note: string) => {
      setBusy(true)
      setNotice(null)
      try {
        const outcome: AnswerOutcome = await transport.answerQuestion(id, chose, note)
        if (!outcome.ok) {
          setNotice({ tone: 'bad', message: outcome.error ?? 'The answer was refused.' })
          return
        }

        setNotice({
          tone: 'ok',
          message: outcome.changesetId
            ? `answered ${id} · raised changeset ${outcome.changesetId} for review`
            : `answered ${id} · no spec change`,
        })
        await load()
      } catch (cause) {
        setNotice({ tone: 'bad', message: (cause as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [load, transport],
  )

  // GH #137: human override of @coder's blocking flag. A field write, not an answer — reload so
  // the question re-sorts (blocking floats to the top). No-op if the host doesn't implement it.
  const setBlocking = useCallback(
    async (id: string, blocking: boolean) => {
      if (!transport.setQuestionBlocking) return
      setBusy(true)
      setNotice(null)
      try {
        const outcome = await transport.setQuestionBlocking(id, blocking)
        if (!outcome.ok) {
          setNotice({ tone: 'bad', message: outcome.error ?? 'Could not change the blocking flag.' })
          return
        }
        await load()
      } catch (cause) {
        setNotice({ tone: 'bad', message: (cause as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [load, transport],
  )

  // GH #143: save the System Brief and update the shown identity (no glossary reload — it's project
  // identity, not glossary content). No-op if the host doesn't implement it.
  const setBrief = useCallback(
    async (brief: string) => {
      if (!transport.setProjectBrief) return
      setBusy(true)
      setNotice(null)
      try {
        const updated = await transport.setProjectBrief(brief)
        setProject(updated)
        setNotice({ tone: 'ok', message: brief.trim() ? 'saved the system brief' : 'cleared the system brief' })
      } catch (cause) {
        setNotice({ tone: 'bad', message: (cause as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [transport],
  )

  /**
   * Both writes reload and report, and neither goes through `commit` — that helper speaks in
   * ops applied and files written, which is the vocabulary of changing the glossary. These do
   * not change it; they change what is expected of it.
   */
  const recordExpectation = useCallback(
    async <T extends { ok: boolean; error?: string }>(
      action: () => Promise<T>,
      describe: (outcome: T) => string,
    ) => {
      setBusy(true)
      setNotice(null)
      try {
        const outcome = await action()
        if (!outcome.ok) {
          setNotice({ tone: 'bad', message: outcome.error ?? 'Refused.' })
          return
        }
        setNotice({ tone: 'ok', message: describe(outcome) })
        await load()
      } catch (cause) {
        setNotice({ tone: 'bad', message: (cause as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const raise = useCallback(
    (
      draft: { terms: string[]; given: string; expect: string },
      contested: Array<{ kind: string; subject: string; detail: string; quote?: string }>,
    ) => {
      const clashes = contested.filter((finding) => finding.kind === 'contradicts')
      void recordExpectation(
        () => transport.raiseExpectation({ kind: 'functional', ...draft }, contested),
        (outcome) =>
          clashes.length > 0
            ? `raised ${outcome.id}, contested — it disagrees with ${clashes.map((c) => c.subject).join(', ')}, so it covers nothing until someone settles which side gives`
            : `raised ${outcome.id} · live now — the committed snapshot is behind, refresh it before the next implementation pass`,
      )
    },
    [recordExpectation, transport],
  )

  const recheck = useCallback(
    (id: string) => {
      void recordExpectation(
        () => transport.recheckExpectation(id),
        (outcome) => {
          const clashes = outcome.expectation?.contested ?? []
          return clashes.length === 0
            ? `${id} re-checked · nothing clashes any more, so it counts as coverage again`
            : `${id} re-checked · still clashes with ${clashes.map((clash) => clash.subject).join(', ')}`
        },
      )
    },
    [recordExpectation, transport],
  )

  const supersede = useCallback(
    (id: string, draft: { note: string; replacement: ExpectationDraft | null }) => {
      void recordExpectation(
        () => transport.supersedeExpectation(id, draft.note, draft.replacement),
        (outcome) =>
          outcome.replacement
            ? `${id} retired to expectations/retired · replaced by ${outcome.replacement.id}`
            : `${id} retired to expectations/retired · nothing replaces it`,
      )
    },
    [recordExpectation, transport],
  )

  return {
    // data
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
    // status
    error,
    setError,
    busy,
    notice,
    setNotice,
    // actions
    load,
    selectOrg,
    selectProject,
    commit,
    recordAnswer,
    // undefined when the transport can't do it, so a host can gate the UI on its presence.
    setBlocking: transport.setQuestionBlocking ? setBlocking : undefined,
    setBrief: transport.setProjectBrief ? setBrief : undefined,
    raise,
    recheck,
    supersede,
  }
}
