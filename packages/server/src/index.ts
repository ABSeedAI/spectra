import { mkdirSync } from 'node:fs'
import express from 'express'
import { anthropicProxy } from './anthropicProxy.js'
import { answerQuestion } from '@abseed/spectra-core'
import { applyChangeset, markImplemented, rejectChangeset } from '@abseed/spectra-core'
import { glossaryVersion } from '@abseed/spectra-core'
import { chatRoutes } from './agent/routes.js'
import { mcpRoutes } from './agent/mcpHttp.js'
import { AgentRunner } from './agent/runner.js'
import { AgentProvider } from './agent/agentProvider.js'
import {
  DEFAULT_SCHEDULER_CONFIG,
  TimerScheduler,
  countdownNotice,
  firingNotice,
  implementInstruction,
} from './agent/implementationScheduler.js'
import { buildAgents } from './agent/agents.js'
import { DATA_DIR, TRANSCRIPTS_DB, resolveTranscriptStore } from './transcripts.js'
import { CODER_URL, SPEC_URL, probeSandbox } from './sandbox.js'
import { currentSnapshot, deployedVersion, lastExport } from './specsExport.js'
import { computeCoverage } from '@abseed/spectra-core'
import { checkExpectation } from './expectationCheck.js'
import { publishExpectation, raiseExpectation, recheckExpectation, supersedeExpectation } from '@abseed/spectra-core'
import type { RaiseExpectationRequest, SupersedeRequest } from '@abseed/spectra-core'
import { raiseScenario } from '@abseed/spectra-core'
import type { RaiseScenarioRequest } from '@abseed/spectra-core'
import { SPECS_DIR } from './config.js'
import { resolveBackend } from './backend.js'
import type { SpecStoreBackend } from './backend.js'
import { resolveAuthorizer } from './auth.js'
import type { Principal } from './auth.js'
import { isSafeSegment, projectScope } from './projectScope.js'
import type { SpecStore } from '@abseed/spectra-core'
import { defaultVoiceIds, listVoices, speechKey, speechModel, synthesize } from './speech.js'

const PORT = Number(process.env.PORT ?? 5174)

// The composition root. The storage backend is fixed for the deployment — the built-in filesystem or
// SQLite (SPEC_STORE=fs|sql), or a module the server does not ship (any other SPEC_STORE value, loaded
// by resolveBackend). Which project a request is for is resolved per request; the backend turns that
// projectId into the store for it. The rest of the server sees only the SpecStoreBackend interface.
const provider: SpecStoreBackend = await resolveBackend(process.env, SPECS_DIR, DATA_DIR)
const transcripts = await resolveTranscriptStore(process.env, DATA_DIR)

// The org this deployment serves. A grouping/auth label, not a storage key — projectId is globally
// unique, so the org never reaches the store. Local default is "local"; a hosted deployment sets it.
// `spectra init` will write it into .spectra/config.json alongside the project id (a later slice).
const ORG = process.env.ORG ?? 'local'

// The boot-time store, for the pieces still constructed once: the project identity the agents are
// built from, and the runner/MCP surface (both request-scoped in later slices — per-project agents,
// transcripts, coder path). It is the provider's store for the default project, so there is a single
// place that builds stores even while these consumers are not yet per-request.
const bootStore = provider.storeFor(provider.defaultProjectId)

// The project's identity is glossary content, read once at startup. The boot agents are still used
// for the two surfaces that are not yet per-project: the chat /agents labels (project-independent)
// and the MCP profile/tools the sandbox fetches (its projectId arrives with the coder path, slice 6).
// The /api/context bootstrap serves this same identity for the default project.
const project = await bootStore.projectInfo()
const agents = buildAgents(project)

// The in-process @coder (no sandbox) spawns the Claude Code binary with its cwd set to the consumer
// project it implements into. Node refuses to spawn into a directory that does not exist and fails
// with an ENOENT the SDK reports as a misleading "binary failed to launch" libc error — so ensure
// it exists, the same empty placeholder `docker compose up` already creates for the sandboxed path.
// Only when we will actually run in-process: a configured sandbox (CODER_URL) mounts its own
// /work/project and this local dir is never used.
if (!CODER_URL) mkdirSync(agents.coder.cwd, { recursive: true })

// A turn resolves its session's project (slice 5) and runs against that project's store and agents,
// built per project and cached. So the runner takes the resolvers, not a single boot-time pair.
const agentProvider = new AgentProvider(provider)
const runner = new AgentRunner(provider, agentProvider, transcripts)

// Proactive @coder (GH #133): applying a changeset should update the code without the human
// hand-pinging @coder each time. The scheduler debounces applies into one turn; it fires only into
// a project's most-recently-active *unattended* conversation, because an auto-started turn that
// then stalls on an approval card nobody is there to click would be worse than not starting. No
// eligible session means nothing runs — the existence of an unattended conversation is the opt-in.
const SCHEDULER_CONFIG = {
  windowMs: Number(process.env.IMPLEMENT_WINDOW_MS) || DEFAULT_SCHEDULER_CONFIG.windowMs,
  maxWaitMs: Number(process.env.IMPLEMENT_MAX_WAIT_MS) || DEFAULT_SCHEDULER_CONFIG.maxWaitMs,
}
const targetSessionFor = async (projectId: string): Promise<string | null> => {
  // listSessions is newest-first, so the first unattended one is the most recent — where the human
  // most likely is, and the only place a hands-off turn is defensible.
  for (const session of await transcripts.listSessions(projectId)) {
    if (runner.isUnattended(session.id)) return session.id
  }
  return null
}
const scheduler = new TimerScheduler(
  {
    onOpen: async (projectId) => {
      const target = await targetSessionFor(projectId)
      if (target) await runner.notify(target, 'coder', countdownNotice(SCHEDULER_CONFIG.windowMs))
    },
    onFire: async (projectId, changes) => {
      const target = await targetSessionFor(projectId)
      if (!target) return 'dropped' // unattended was turned off during the window — nothing to run
      if (runner.isRunning(target)) return 'retry' // @coder is mid-turn; wait a window and try again
      await runner.notify(target, 'coder', firingNotice(changes))
      const outcome = await runner.autoImplement(target, implementInstruction(changes))
      return outcome.ok ? 'sent' : 'retry'
    },
  },
  SCHEDULER_CONFIG,
)

// Who a request is, and what it may touch, is the server's call — never the request body, the
// same reason an agent's identity comes from its route. The authorizer resolves a principal per
// request; locally that is allow-all and stamps a bare human, exactly what this used to hardcode.
// A hosted deployment swaps the implementation without the routes changing.
const authorizer = await resolveAuthorizer(process.env, ORG)

/** The principal the auth middleware resolved for this request. */
const principalOf = (res: express.Response): Principal => res.locals.principal as Principal

/** The glossary store for this request's project, resolved by the projectScope middleware. */
const storeOf = (res: express.Response): SpecStore => res.locals.store as SpecStore

/** The revision the client last read, if it sent one — the opt-in for optimistic concurrency. */
const expectedRevOf = (body: unknown): number | undefined => {
  const value = (body as { expectedRev?: unknown } | null)?.expectedRev
  return typeof value === 'number' ? value : undefined
}

const app = express()

// Before express.json(), and that ordering is load-bearing: the proxy forwards the request
// body untouched, and a JSON parser upstream of it would consume the stream first.
app.use('/anthropic', anthropicProxy())

app.use(express.json())

// Authenticate every request (who) before any route. The project (what) is resolved from the URL,
// per glossary route, in the router below. Runs after the /anthropic proxy, which terminates its
// own requests and needs no principal.
app.use((req, res, next) => {
  // Express does not await middleware, so resolve the principal ourselves and forward any auth
  // failure into the error chain rather than leaving a floating rejection.
  authorizer
    .authenticate(req)
    .then((principal) => {
      res.locals.principal = principal
      next()
    })
    .catch(next)
})

// The bootstrap the browser reads first, before it knows which org/project it is looking at. It is
// deliberately un-prefixed — you cannot ask for a project's routes until you have been told the
// project. Returns the one configured scope and its identity (saving a round trip for the title).
app.get('/api/context', (_req, res) => {
  res.json({ org: ORG, projectId: provider.defaultProjectId, project })
})

// The org picker's source: the orgs this caller may see. Auth's call, so it comes from the
// principal — locally the one configured org, later the orgs an account belongs to.
app.get('/api/orgs', (_req, res) => {
  res.json({ orgs: principalOf(res).orgs().map((id) => ({ id, name: id })) })
})

// The project picker's source: every project this deployment holds in the org, filtered to the ones
// the caller may open. Un-prefixed (no :projectId) — this is how you *choose* the project, the same
// role as /api/context. The glossary mount needs a :projectId segment, so it never shadows this.
app.get('/api/orgs/:org/projects', async (req, res, next) => {
  try {
    const { org } = req.params
    if (!isSafeSegment(org)) {
      res.status(400).json({ error: 'Invalid org id.' })
      return
    }
    const principal = principalOf(res)
    if (!principal.orgs().includes(org)) {
      res.status(403).json({ error: `Not authorized for org "${org}".` })
      return
    }
    const projects = (await provider.listProjects()).filter((p) => principal.can(org, p.id))
    res.json({ projects })
  } catch (error) {
    next(error)
  }
})

// The one gate every project surface shares: validate the ids, authorize, resolve the store onto
// res.locals. Both the glossary routes and the MCP surface mount behind it.
const scope = projectScope(provider)

// The sandbox's surface, deliberately outside /api — reached over the internal docker network by an
// agent in another container. Now under the same project prefix as everything else: the @coder
// container is bound to one project and carries it in the URL, so its profile fetch and tool calls
// act on that project's glossary. mergeParams so mcpRoutes sees the params (it reads res.locals).
app.use('/mcp/orgs/:org/projects/:projectId', scope, mcpRoutes(agentProvider, transcripts))

// Everything about one project lives under /api/orgs/<org>/projects/<projectId>. mergeParams so the
// handlers below see :org and :projectId from the mount path; `scope` (mounted with it) resolves the
// project and store before any of them run.
const glossary = express.Router({ mergeParams: true })

// Chat lives under the project prefix too: a conversation is about one project's glossary. Its
// handlers read res.locals.projectId (set above) to create and list sessions per project. The
// runner and its transcripts are still one process-wide pair — sessions carry their projectId as
// a column; per-turn store/agents by that projectId is the next slice.
glossary.use('/chat', chatRoutes(transcripts, runner, agents))

// The project's identity, for the UI title — the request's project, read live from its store.
glossary.get('/project', async (_req, res, next) => {
  try {
    res.json(await storeOf(res).projectInfo())
  } catch (error) {
    next(error)
  }
})

// GH #143: set (or clear) the System Brief. Human-authored product framing; empty string clears it.
glossary.post('/project/brief', async (req, res, next) => {
  try {
    const body = req.body as { brief?: unknown }
    if (typeof body?.brief !== 'string') {
      res.status(400).json({ error: 'Expected { brief: string }.' })
      return
    }
    await storeOf(res).setProjectBrief(body.brief)
    res.json(await storeOf(res).projectInfo())
  } catch (error) {
    next(error)
  }
})

glossary.get('/terms', async (_req, res, next) => {
  try {
    // `version` is the glossary's content token (GH #93): the UI records it and passes it back as
    // `expectedVersion` when applying, so a change reviewed against a since-moved glossary is refused.
    const glossary = await storeOf(res).readTerms()
    res.json({ ...glossary, version: glossaryVersion(glossary.terms) })
  } catch (error) {
    next(error)
  }
})

glossary.get('/changesets', async (_req, res, next) => {
  try {
    res.json(await storeOf(res).readChangesets())
  } catch (error) {
    next(error)
  }
})

glossary.post('/changesets/:id/apply', async (req, res, next) => {
  try {
    const body = req.body as { opIndices?: unknown; acknowledgeWarnings?: unknown; expectedVersion?: unknown }
    if (!Array.isArray(body?.opIndices)) {
      res.status(400).json({ error: 'Expected { opIndices: number[] }.' })
      return
    }

    const outcome = await applyChangeset(storeOf(res), req.params.id, {
      opIndices: body.opIndices as number[],
      acknowledgeWarnings: body.acknowledgeWarnings === true,
      // Optimistic concurrency (GH #93): the version the UI reviewed against, if it sent one.
      expectedVersion: typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
    })
    // A successful apply that actually changed terms is a spec change @coder may need to implement:
    // hand it to the debounce (GH #133), which batches a burst of applies into one turn. A no-op
    // apply, or a refusal, is not a change and does not arm anything.
    if (outcome.ok && (outcome.written.length > 0 || outcome.deleted.length > 0)) {
      scheduler.noteApplied(res.locals.projectId as string, {
        changesetId: req.params.id,
        written: outcome.written,
        deleted: outcome.deleted,
      })
    }
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

glossary.post('/changesets/:id/reject', async (req, res, next) => {
  try {
    const outcome = await rejectChangeset(storeOf(res), req.params.id)
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

glossary.post('/changesets/:id/implemented', async (req, res, next) => {
  try {
    const outcome = await markImplemented(storeOf(res), req.params.id, new Date().toISOString())
    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

/**
 * The two versions, reported side by side. No verdict.
 *
 * `specsVersion` is what specs/ is at now; `snapshotVersion` is what the copy committed in
 * app/ is at, read from the artifact — directly when @coder runs here, or from the sandbox
 * reporting its own mount when it does not. Whoever needs to act compares them, the way you
 * would read `git status`.
 *
 * `lastExport` is a timestamp and nothing more. It records that the tool was called, which
 * is not the same as the file being written — the write still has to pass the approval card
 * — so it is here to answer "how long ago?" and never to decide anything.
 */
glossary.get('/specs/version', async (_req, res, next) => {
  try {
    res.json({
      specsVersion: (await currentSnapshot(storeOf(res))).version,
      snapshotVersion: await deployedVersion(),
      lastExport: lastExport(),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/sandbox', async (_req, res, next) => {
  try {
    res.json(await probeSandbox())
  } catch (error) {
    next(error)
  }
})

/**
 * Which remote voices exist, if any — and never a verdict about whether to use one.
 *
 * `configured` is only "is there a key", not "does it work": finding that out costs a call to
 * the vendor, and a UI that cannot paint its voice picker until a third party answers is a UI
 * that hangs for a feature nobody switched on yet. The browser asks, and treats an empty list
 * exactly as it treats a machine with one system voice.
 *
 * Lives under the project prefix like every other UI call (the browser reaches it through the same
 * `apiPath`), rather than as a bare top-level route. A self-hosted key is a single process-wide
 * credential and ignores which project asked — but keeping speech beside the other project calls is
 * what lets a deployment that scopes credentials per project resolve the right one from the URL.
 */
glossary.get('/speech', async (_req, res, next) => {
  try {
    if (!speechKey()) {
      res.json({ configured: false, voices: [], defaults: {}, model: speechModel })
      return
    }
    const outcome = await listVoices()
    res.json({
      configured: true,
      model: speechModel,
      defaults: defaultVoiceIds(),
      voices: 'voices' in outcome ? outcome.voices : [],
      ...('error' in outcome ? { error: outcome.error } : {}),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * One utterance of audio.
 *
 * A failure comes back as JSON naming the shape of it, not as a bare status, because the
 * caller has a real decision to make and the two interesting cases look identical from the
 * outside: a spent quota should send the browser back to its local voice for good, while a
 * rate limit should cost it one sentence. 200 is audio; anything else is a reason.
 */
glossary.post('/speech', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    const voiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId : ''
    if (!text || !voiceId) {
      res.status(400).json({ error: 'Expected { text: string, voiceId: string }.' })
      return
    }

    const outcome = await synthesize(text, voiceId)
    if ('error' in outcome) {
      res.status(outcome.error.reason === 'no-credential' ? 501 : 502).json(outcome.error)
      return
    }

    res.setHeader('Content-Type', outcome.type)
    res.setHeader('Cache-Control', 'no-store')
    res.send(outcome.audio)
  } catch (error) {
    next(error)
  }
})

glossary.get('/expectations', async (_req, res, next) => {
  try {
    res.json(await storeOf(res).readExpectations())
  } catch (error) {
    next(error)
  }
})

glossary.get('/scenarios', async (_req, res, next) => {
  try {
    res.json(await storeOf(res).readScenarios())
  } catch (error) {
    next(error)
  }
})

/**
 * Raise a scenario — a stored, cross-entity spec-level test case. Add-only and unapproved, the way
 * raising a question or an expectation is: it asserts an outcome across several terms but changes
 * nothing, so the most it can do is fail and reveal a gap.
 */
glossary.post('/scenarios', async (req, res, next) => {
  try {
    const body = req.body as Partial<RaiseScenarioRequest>
    if (typeof body?.title !== 'string' || body.title.trim() === '') {
      res.status(400).json({ error: 'Expected { title: string }.' })
      return
    }
    const expect = Array.isArray(body.expect)
      ? body.expect.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : []
    if (expect.length === 0) {
      res.status(400).json({ error: 'Expected { expect: string[] } with at least one assertion.' })
      return
    }

    const outcome = await raiseScenario(
      storeOf(res),
      {
        title: body.title,
        terms: Array.isArray(body.terms) ? body.terms.filter((term): term is string => typeof term === 'string') : [],
        given: typeof body.given === 'string' ? body.given : '',
        steps: Array.isArray(body.steps) ? body.steps.filter((step): step is string => typeof step === 'string') : [],
        expect,
        pass: typeof body.pass === 'string' && body.pass ? body.pass : 'usage',
        ...(typeof body.from === 'string' ? { from: body.from } : {}),
        ...(typeof body.file === 'string' ? { file: body.file } : {}),
      },
      principalOf(res).author,
    )

    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

/**
 * Read a draft against the glossary without writing it.
 *
 * Nothing here touches disk, which is the point: a draft that turns out to contradict a spec
 * should be killable before it exists, not superseded afterwards. The mechanical findings
 * always come back; the semantic ones need a credential and say so when they are missing.
 */
glossary.post('/expectations/check', async (req, res, next) => {
  try {
    const body = req.body as Partial<RaiseExpectationRequest>
    if (typeof body?.expect !== 'string' || body.expect.trim() === '') {
      res.status(400).json({ error: 'Expected { expect: string }.' })
      return
    }

    const [{ terms }, { expectations }] = await Promise.all([storeOf(res).readTerms(), storeOf(res).readExpectations()])

    // A replacement is prefilled from the expectation it replaces, so comparing it against
    // that expectation reports a duplicate of the very thing being retired. Excluded rather
    // than tolerated: a finding everybody learns to ignore devalues the ones that matter.
    const superseding = (req.body as { superseding?: unknown }).superseding
    const against =
      typeof superseding === 'string'
        ? expectations.filter((entry) => entry.id !== superseding)
        : expectations

    res.json(
      await checkExpectation(
        {
          kind: body.kind === 'non-functional' ? 'non-functional' : 'functional',
          terms: Array.isArray(body.terms) ? body.terms : [],
          given: typeof body.given === 'string' ? body.given : '',
          expect: body.expect,
        },
        terms,
        against,
      ),
    )
  } catch (error) {
    next(error)
  }
})

/**
 * The write itself. The check above is a separate call rather than a step inside this one —
 * the UI gates on it, but a caller that has already decided is not made to pay for a model
 * round trip, and a check that could not run must not become a write that cannot happen.
 */
glossary.post('/expectations', async (req, res, next) => {
  try {
    const body = req.body as Partial<RaiseExpectationRequest>
    if (body?.kind !== 'functional' && body?.kind !== 'non-functional') {
      res.status(400).json({ error: 'Expected { kind: "functional" | "non-functional" }.' })
      return
    }
    if (typeof body.expect !== 'string' || body.expect.trim() === '') {
      res.status(400).json({ error: 'Expected { expect: string }.' })
      return
    }

    const outcome = await raiseExpectation(storeOf(res), {
      kind: body.kind,
      terms: Array.isArray(body.terms) ? body.terms : [],
      given: typeof body.given === 'string' ? body.given : '',
      expect: body.expect,
      pass: typeof body.pass === 'string' && body.pass ? body.pass : 'usage',
      ...(typeof body.from === 'string' ? { from: body.from } : {}),
      ...(typeof body.file === 'string' ? { file: body.file } : {}),
      ...(Array.isArray(body.contested) ? { contested: body.contested } : {}),
      // A person may save a draft; anything else publishes. Agents never reach here.
      ...(body.status === 'draft' ? { status: 'draft' as const } : {}),
    }, principalOf(res).author)

    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

/** Publish a draft expectation. draft → ready, and only then does it count. */
glossary.post('/expectations/:id/publish', async (req, res, next) => {
  try {
    const outcome = await publishExpectation(storeOf(res), req.params.id, expectedRevOf(req.body))
    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

/**
 * Reads a live expectation against the specs as they are now.
 *
 * Answering a question rewrites term text, which can leave a `contested` marker quoting a
 * sentence that no longer exists — flagged for a reason nobody can check. This refreshes it:
 * a clash that has gone disappears, one that changed says what it clashes with now, and one
 * that survives keeps the expectation out of coverage exactly as before.
 */
glossary.post('/expectations/:id/recheck', async (req, res, next) => {
  try {
    const [{ terms }] = await Promise.all([storeOf(res).readTerms()])
    const outcome = await recheckExpectation(storeOf(res), req.params.id, async (expectation, others) => {
      const report = await checkExpectation(
        {
          kind: expectation.kind,
          terms: expectation.terms,
          given: expectation.given,
          expect: expectation.expect,
        },
        terms,
        others,
      )
      return report.findings
    }, expectedRevOf(req.body))

    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

glossary.post('/expectations/:id/supersede', async (req, res, next) => {
  try {
    const body = req.body as Partial<SupersedeRequest>
    if (typeof body?.note !== 'string' || body.note.trim() === '') {
      res.status(400).json({ error: 'Expected { note: string } saying why this no longer applies.' })
      return
    }

    const outcome = await supersedeExpectation(storeOf(res), req.params.id, {
      note: body.note,
      ...(body.replacement ? { replacement: body.replacement } : {}),
    }, principalOf(res).author, expectedRevOf(req.body))

    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

/**
 * Which pairs of entity and action nobody has said anything about.
 *
 * Counts and lists, never a score — the same reason `/api/specs/version` reports two numbers
 * and offers no verdict. Expectations per term measure attention, not correctness, and a
 * percentage would invite reading them as the second thing.
 */
glossary.get('/coverage', async (req, res, next) => {
  try {
    const [{ terms }, { expectations }] = await Promise.all([storeOf(res).readTerms(), storeOf(res).readExpectations()])
    const distance = Number(req.query.distance ?? 2)
    res.json(
      computeCoverage(terms, expectations, {
        maxDistance: Number.isFinite(distance) ? Math.max(1, Math.min(4, distance)) : 2,
      }),
    )
  } catch (error) {
    next(error)
  }
})

glossary.get('/questions', async (_req, res, next) => {
  try {
    res.json(await storeOf(res).readQuestions())
  } catch (error) {
    next(error)
  }
})

glossary.post('/questions/:id/answer', async (req, res, next) => {
  try {
    const body = req.body as { chose?: unknown; note?: unknown }
    const chose = body?.chose === null || body?.chose === undefined ? null : body.chose
    if (chose !== null && typeof chose !== 'string') {
      res.status(400).json({ error: 'Expected { chose: string | null, note?: string }.' })
      return
    }

    const outcome = await answerQuestion(storeOf(res), req.params.id, {
      chose,
      note: typeof body?.note === 'string' ? body.note : '',
      answeredAt: new Date().toISOString(),
    }, principalOf(res).author)
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

// GH #137: the human override over @coder's blocking flag. A plain field write, guarded by the
// store's rev CAS; no answer semantics, so it stays a separate route from /answer.
glossary.post('/questions/:id/blocking', async (req, res, next) => {
  try {
    const body = req.body as { blocking?: unknown }
    if (typeof body?.blocking !== 'boolean') {
      res.status(400).json({ error: 'Expected { blocking: boolean }.' })
      return
    }
    const result = await storeOf(res).setQuestionBlocking(req.params.id, body.blocking)
    if (!result.ok) {
      res.status(result.reason === 'not-found' ? 404 : 409).json(result)
      return
    }
    res.json(result)
  } catch (error) {
    next(error)
  }
})

app.use('/api/orgs/:org/projects/:projectId', scope, glossary)

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error)
  res.status(500).json({ error: error.message })
})

app.listen(PORT, () => {
  console.log(`[server] specs: ${SPECS_DIR}`)
  console.log(`[server] transcripts: ${TRANSCRIPTS_DB}`)
  const misconfigured = AgentRunner.misconfiguration
  console.log(
    misconfigured
      ? `[server] chat: ${misconfigured}`
      : AgentRunner.configured
        ? '[server] chat: agent ready'
        : '[server] chat: no credential — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN and restart',
  )
  console.log(
    CODER_URL
      ? `[server] @coder: relayed to ${CODER_URL} — GET /api/sandbox for whether it is actually up`
      : `[server] @coder: in-process (CODER_URL unset) in ${agents.coder.cwd}`,
  )
  console.log(
    SPEC_URL
      ? `[server] @spec: relayed to ${SPEC_URL}`
      : '[server] @spec: in-process (SPEC_URL unset)',
  )
  console.log(`[server] listening on http://localhost:${PORT}`)
})
