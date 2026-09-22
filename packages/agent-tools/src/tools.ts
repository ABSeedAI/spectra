/**
 * The agent's tool surface — the pure, transport-agnostic half.
 *
 * These are domain tools, not file tools, and that is the whole point. The human write path is
 * changesets-only; if the agent had `Write` on the glossary it could edit a term directly and the
 * discipline would rest on the system prompt asking it not to. Here it rests on there being no such
 * tool. The agent physically cannot bypass review.
 *
 * WHY this is its own package, not `@abseed/spectra-core`: these schemas are consumed by the agent SDK,
 * which peer-requires zod 4, while core is zod 3. So the tool definitions live here (zod 4, no node
 * builtins, no SDK dependency) where both the open server and the hosted coordinator can import them
 * — the server registers them in-process and over HTTP, the Worker over its fetch-native MCP.
 *
 * Only the *pure* tools live here: reads, plus `propose_changeset` and `raise_question` (whose write
 * logic is in core). The three that touch the host — `raise_expectation` (a model-backed check),
 * `mark_implemented` and `export_specs` (a filesystem snapshot) — stay in the server and are composed
 * on top of these (see the server's `toolsFor`).
 *
 * The tool objects are plain `SdkMcpToolDefinition`-shaped records (see {@link defineTool}); the agent
 * SDK's `tool()` helper is only a typed constructor for that same shape, so we reproduce it here
 * rather than depend on the SDK.
 */
import { z } from 'zod'
import { analyzePending, computeBacklinks, computeCoverage, proposeChangeset, raiseQuestion, raiseScenario, summarizeOp } from '@abseed/spectra-core'
import type { Author, Changeset, PendingItem, ProposeRequest, Question, RaiseRequest, SpecStore, Term, TranscriptStore } from '@abseed/spectra-core'

/** MCP tools answer with content blocks; every tool here returns one JSON or text block. */
export interface CallResult {
  content: Array<{ type: 'text'; text: string }>
}

/** Read-only/behaviour hints passed through to the MCP registration, mirroring the SDK's shape. */
export type ToolAnnotations = { readOnlyHint?: boolean } & Record<string, unknown>

/**
 * A tool as both consumers expect it: the agent SDK's `SdkMcpToolDefinition` (for the in-process
 * server) and the MCP SDK's `registerTool` (for the HTTP/fetch server) both read exactly these
 * fields, so this one shape serves both.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallResult>
  annotations?: ToolAnnotations
}

/**
 * The plain-object equivalent of the SDK's `tool()` — a constructor, no runtime behaviour. Exported
 * so the server can define its host-coupled tools (raise_expectation, mark_implemented, export_specs)
 * in the same shape and compose them with these.
 */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>, extra: unknown) => Promise<CallResult>,
  annotations?: ToolAnnotations,
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: handler as ToolDef['handler'],
    ...(annotations ? { annotations } : {}),
  }
}

/**
 * An op as the *tool* accepts it: one flat shape with an enum tag and optional fields, rather than
 * the discriminated union the engine uses. Nested inside `options[] → proposal → ops[]`, a
 * `z.discriminatedUnion` defeats the SDK's JSON-Schema conversion and the whole MCP server silently
 * fails to register. Nothing is lost: both write paths run the real schema over the result before
 * writing, so a malformed op is rejected there with a readable message rather than landing on disk.
 */
const attributeInput = z.object({
  name: z.string(),
  valueType: z.string().describe('string | number | boolean | date | ref:<TermName>, each with an optional [] suffix'),
  default: z.unknown().optional(),
  optional: z.boolean().optional(),
})

const opInput = z.object({
  op: z.enum(['add_entity', 'remove_entity', 'add_attribute', 'remove_attribute', 'modify_spec']),
  term: z.string().describe('The term this op targets'),
  termType: z.enum(['entity', 'event', 'function', 'attribute-type']).optional().describe('add_entity only; defaults to entity'),
  parent: z.string().nullable().optional().describe('add_entity only'),
  spec: z.string().optional().describe('Required for add_entity and modify_spec'),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeInput).optional().describe('add_entity only'),
  attribute: z
    .union([attributeInput, z.string()])
    .optional()
    .describe('add_attribute takes the attribute object; remove_attribute takes just its name as a string'),
})

const proposalInput = z.object({
  summary: z.string(),
  ops: z.array(opInput),
  tests: z.array(z.string()).describe('Plain-language behaviours this change commits to'),
})

/** Every tool answers with one content block — JSON when structured, text otherwise. */
export function say(value: unknown): CallResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
}

/** A term plus the relationships that make it make sense — the useful unit, not the file. */
function describeTerm(terms: Term[], name: string) {
  const term = terms.find((candidate) => candidate.name === name)
  if (!term) return null

  const backlinks = computeBacklinks(terms)
  return {
    ...term,
    children: backlinks.children[name] ?? [],
    referencedBy: (backlinks.byTarget[name] ?? []).map((reference) => ({ from: reference.from, via: reference.via })),
  }
}

/** Everything pending, flattened into comparable op-lists for the conflict analysis. */
function pendingItems(changesets: Changeset[], questions: Question[]): PendingItem[] {
  const items: PendingItem[] = changesets.map((changeset) => ({
    id: changeset.id,
    kind: 'changeset',
    label: changeset.summary,
    ops: changeset.ops,
  }))

  for (const question of questions) {
    if (question.answer) continue
    for (const option of question.options) {
      if (!option.proposal) continue
      items.push({
        id: `${question.id}:${option.label}`,
        kind: 'question-option',
        label: `${question.id} — ${option.label}`,
        ops: option.proposal.ops,
      })
    }
  }

  return items
}

/**
 * The pure tools, constructed for a given store/transcripts/author. No version stamping here — that
 * is applied by {@link withVersion}, so the server (filesystem snapshot) and the cloud (its own
 * scheme) can each supply how the current version is read.
 */
export function pureTools(store: SpecStore, transcripts: TranscriptStore, author: Author): ToolDef[] {
  const readGlossary = defineTool(
    'read_glossary',
    'Read the spec glossary. Omit `term` for every term in summary form; supply one to get its full spec, attributes, subtypes and everything that references it.',
    { term: z.string().optional().describe('A single term name, e.g. "Task"') },
    async (args) => {
      const { terms, problems } = await store.readTerms()
      if (args.term) {
        const described = describeTerm(terms, args.term)
        return say(described ?? { error: `No term named "${args.term}".`, known: terms.map((term) => term.name) })
      }
      return say({
        terms: terms.map((term) => ({
          name: term.name,
          type: term.type,
          spec: term.spec,
          parent: term.parent,
          attributes: term.attributes.map((attribute) => `${attribute.name}: ${attribute.valueType}`),
        })),
        problems,
      })
    },
    { readOnlyHint: true },
  )

  const readQuestions = defineTool(
    'read_questions',
    'Read questions raised against the glossary — what it does not settle, and what has been decided. Answered questions are the record of why the specs say what they say.',
    { status: z.enum(['open', 'answered', 'all']).optional().describe('Defaults to "all"') },
    async (args) => {
      const { questions, problems } = await store.readQuestions()
      const status = args.status ?? 'all'
      const filtered = questions.filter((question) =>
        status === 'all' ? true : status === 'open' ? !question.answer : Boolean(question.answer),
      )
      return say({
        questions: filtered.map((question) => ({
          id: question.id,
          asks: question.asks,
          because: question.because,
          raisedBy: question.raisedBy,
          options: question.options.map((option) => ({
            label: option.label,
            detail: option.detail,
            ops: option.proposal?.ops.map(summarizeOp) ?? null,
          })),
          answer: question.answer,
        })),
        problems,
      })
    },
    { readOnlyHint: true },
  )

  const readChangesets = defineTool(
    'read_changesets',
    'Read changesets: `outstanding` are applied but not yet implemented — the work, and where to find the id mark_implemented wants. `pending` are proposed and awaiting human review; do not implement those, they may still be rejected or changed. `implemented` is history.',
    {},
    async () => {
      const { changesets, applied, problems } = await store.readChangesets()
      const describe = (changeset: (typeof applied)[number]) => ({
        id: changeset.id,
        summary: changeset.summary,
        fromQuestion: changeset.fromQuestion,
        appliedAt: changeset.appliedAt,
        ops: changeset.ops.map(summarizeOp),
        tests: changeset.tests,
      })
      return say({
        outstanding: applied.filter((changeset) => !changeset.implementedAt).map(describe),
        pending: changesets.map(describe),
        implemented: applied
          .filter((changeset) => changeset.implementedAt)
          .map((changeset) => ({ id: changeset.id, summary: changeset.summary, implementedAt: changeset.implementedAt })),
        problems,
      })
    },
    { readOnlyHint: true },
  )

  const readExpectations = defineTool(
    'read_expectations',
    'Read the expectations — what someone should be able to expect, stated outside the prose of the specs. Functional ones become tests over the domain; non-functional ones describe a running build. Pass `coverage` to get which entity/action pairs nothing has been said about yet, nearest first: that list is the work queue for what the glossary has named but nobody has thought through.',
    {
      coverage: z.boolean().optional().describe('Return the pair-coverage report instead of the expectation list'),
      term: z.string().optional().describe('Only expectations naming this term'),
    },
    async (args) => {
      const [{ terms }, { expectations, retired, problems }] = await Promise.all([store.readTerms(), store.readExpectations()])
      if (args.coverage) {
        const report = computeCoverage(terms, expectations)
        return say({
          ...report,
          note: 'Coverage means an expectation exists naming both ends of the pair — not that the behaviour is correct. distance 1 is an action naming the entity directly; 2 is reached through the entity graph, which is where the interactions nobody thought about tend to sit.',
        })
      }
      const wanted = (list: typeof expectations) => (args.term ? list.filter((expectation) => expectation.terms.includes(args.term!)) : list)
      const live = wanted(expectations)
      const contested = live.filter((expectation) => expectation.contested.length > 0)
      return say({
        expectations: live,
        ...(contested.length > 0
          ? {
              warning: `${contested.map((entry) => entry.id).join(', ')} disagree with the specs and were recorded anyway. Do not write code to satisfy a contested expectation and do not change the specs to match it — which side gives is a decision only the human can make. Say what you found and leave it.`,
            }
          : {}),
        retired: wanted(retired).map((expectation) => ({
          id: expectation.id,
          expect: expectation.expect,
          supersededBy: expectation.supersededBy,
          retiredBecause: expectation.retiredBecause,
        })),
        problems,
      })
    },
    { readOnlyHint: true },
  )

  const readScenarios = defineTool(
    'read_scenarios',
    'Read the scenarios — stored, cross-entity spec-level test cases: a concrete situation that combines several terms and asserts an outcome, kept because the combination is worth remembering. Read these before raising one, and to see which cross-cutting cases have already been captured.',
    { term: z.string().optional().describe('Only scenarios naming this term') },
    async (args) => {
      const { scenarios, problems } = await store.readScenarios()
      const wanted = args.term ? scenarios.filter((scenario) => scenario.terms.includes(args.term!)) : scenarios
      return say({ scenarios: wanted, problems })
    },
    { readOnlyHint: true },
  )

  const analyzePendingTool = defineTool(
    'analyze_pending',
    'Work out what to tackle first. Replays every pending changeset and unanswered question option through the changeset engine, alone and in pairs, and reports which ones break which — including cases where order is what matters. Use this before recommending where to start; do not reason it out by hand.',
    {},
    async () => {
      const [{ terms }, { changesets }, { questions }] = await Promise.all([store.readTerms(), store.readChangesets(), store.readQuestions()])
      const items = pendingItems(changesets, questions)
      const report = analyzePending(terms, items)
      return say({
        ...report,
        note: 'A conflict listed as {first, second} means applying `first` before `second` causes the diagnostics shown. If the reverse pair is absent, that order is safe.',
      })
    },
    { readOnlyHint: true },
  )

  const searchTranscripts = defineTool(
    'search_transcripts',
    'Search earlier conversations in this workspace for a word or phrase. Use it before asking the human to repeat context they may already have given.',
    {
      query: z.string().describe('Substring to look for, case-insensitive'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const hits = await transcripts.search(args.query, args.limit ?? 20)
      return say(
        hits.map((hit) => ({ session: hit.title, sessionId: hit.sessionId, role: hit.kind, at: hit.createdAt, text: hit.text })),
      )
    },
    { readOnlyHint: true },
  )

  const raiseQuestionTool = defineTool(
    'raise_question',
    [
      'Raise a question against the glossary. Use this when the specs do not settle something a human must decide — never to record an observation.',
      'If it cannot be phrased as a question someone answers, it does not belong here.',
      '`because` must quote the spec text in conflict. "This was awkward to implement" is not grounds to change a spec; "these two spec sentences cannot both hold" is.',
      'The number of options is the answer shape: one means approve-or-decline, several means a genuine choice (do not signal a favourite by ordering), none means only the human can write the spec text.',
      'Do not use this to propose a change you are confident about and could simply describe — that is what a changeset is for.',
    ].join(' '),
    {
      asks: z.string().describe('The question itself, answerable as written'),
      because: z.string().describe('Why it is being asked, quoting the conflicting spec text verbatim'),
      pass: z.string().describe('What was being done when it came up, e.g. "implementation" or "review"'),
      file: z.string().optional().describe('Source file where it surfaced, if any'),
      terms: z.array(z.string()).describe('Glossary terms the question is about'),
      options: z
        .array(
          z.object({
            label: z.string(),
            detail: z.string().optional().describe('The tradeoff in plain language, including what this choice costs'),
            proposal: proposalInput.nullable().optional().describe('The changeset this option would raise. Null when it changes no specs.'),
          }),
        )
        .describe('Candidate answers; may be empty when only the human can write the spec'),
      blocking: z
        .boolean()
        .optional()
        .describe(
          'Set true only if you (@coder) cannot correctly finish implementing the applied changeset(s) without this answer — it floats the question to the top for the human. Leave unset for a question you can proceed past. Honoured only when you are @coder; ignored otherwise.',
        ),
    },
    async (args) => {
      const outcome = await raiseQuestion(
        store,
        {
          asks: args.asks,
          because: args.because,
          pass: args.pass,
          file: args.file,
          terms: args.terms,
          options: args.options as RaiseRequest['options'],
          blocking: args.blocking,
        },
        author,
      )
      return say(
        outcome.ok
          ? { raised: outcome.id, file: `specs/questions/${outcome.file}`, awaiting: 'a human answer' }
          : { error: outcome.error },
      )
    },
  )

  const raiseScenarioTool = defineTool(
    'raise_scenario',
    [
      'Raise a scenario — a stored, cross-entity spec-level test case: a concrete situation that combines several terms and asserts an outcome, especially one that exposes a case the specs have not covered yet.',
      'A scenario is the integration-test tier; an expectation is the unit-test tier. If what you want to state is a single rule about one entity — "always", "never", one situation\'s outcome — raise an expectation instead. If the specs do not settle something a human must decide, raise a question.',
      'Name every term the situation touches — a scenario is cross-entity by definition. Steps are the walkthrough; state simultaneity in the prose (e.g. "both check out at the same instant"). `expect` is what must hold at the end — at least one assertion.',
      'It changes nothing and needs no approval, the way raising a question does: the most it can do is fail and reveal a gap. Read read_scenarios first so you do not restate one already captured.',
    ].join(' '),
    {
      title: z.string().describe('A short name for the situation'),
      terms: z.array(z.string()).describe('Every glossary term the scenario touches; at least one'),
      given: z.string().optional().describe('The setup, if there is one'),
      steps: z.array(z.string()).optional().describe('Ordered steps of the walkthrough; state simultaneity in the prose'),
      expect: z.array(z.string()).describe('What must hold at the end — at least one assertion'),
      pass: z.string().describe('What was being done when it came up, e.g. "usage" or "implementation"'),
      from: z.string().optional().describe('A question, changeset, or expectation id this follows from, if any'),
      file: z.string().optional(),
    },
    async (args) => {
      const outcome = await raiseScenario(
        store,
        {
          title: args.title,
          terms: args.terms,
          given: args.given,
          steps: args.steps,
          expect: args.expect,
          pass: args.pass,
          ...(args.from ? { from: args.from } : {}),
          ...(args.file ? { file: args.file } : {}),
        },
        author,
      )
      return say(outcome.ok ? { raised: outcome.id, file: `specs/scenarios/${outcome.file}` } : { error: outcome.error })
    },
  )

  const proposeChangesetTool = defineTool(
    'propose_changeset',
    [
      'Propose an edit to the glossary. Use this when the change is clear and there is no product decision left to make — a missing term, a spec that says two things, a name that does not match what it describes.',
      'It lands in the pending queue and changes nothing until a human reviews and applies it, so it is safe to propose; it is not safe to guess.',
      'If the change turns on a choice only the human can make, raise a question instead. Do not settle a fork by proposing one side of it — a changeset that quietly picked a default is far harder to review than a question that names the options.',
      'If the request needs no glossary change at all — presentation, wording in the UI, how something is displayed or implemented — say so and do not propose anything. The glossary describes the domain, not the app that renders it.',
      'Say in your reply what you did not decide. A proposal that names its own open ends is worth more than one that reads as finished.',
    ].join(' '),
    {
      summary: z.string().describe('One line: what this change does'),
      ops: z.array(opInput).describe('The edits, applied in order'),
      tests: z.array(z.string()).describe('Plain-language behaviours this change commits to — what a reviewer should expect to hold afterwards'),
      fromQuestion: z.string().optional().describe('Id of an already-answered question this follows from, if any'),
    },
    async (args) => {
      const outcome = await proposeChangeset(
        store,
        {
          summary: args.summary,
          ops: args.ops as ProposeRequest['ops'],
          tests: args.tests,
          ...(args.fromQuestion ? { fromQuestion: args.fromQuestion } : {}),
        },
        author,
      )
      return say(
        outcome.ok
          ? { proposed: outcome.id, file: `specs/changesets/${outcome.file}`, awaiting: 'human review — nothing has changed in the glossary yet' }
          : { error: outcome.error },
      )
    },
  )

  return [
    readGlossary,
    readQuestions,
    readChangesets,
    readExpectations,
    readScenarios,
    analyzePendingTool,
    searchTranscripts,
    raiseQuestionTool,
    raiseScenarioTool,
    proposeChangesetTool,
  ]
}

/**
 * Stamp every tool's result with the current specs version.
 *
 * A `stale: true` flag would be one process's opinion; a version is a fact both sides hold and
 * compare (the same reason git prints `abc123..def456`). `versionOf` is injected so each host reads
 * it its own way — the server from its filesystem snapshot, the cloud from its store.
 */
export function withVersion(tools: ToolDef[], versionOf: () => Promise<string>): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    handler: async (args: Record<string, unknown>, extra: unknown) => {
      const result = await tool.handler(args, extra)
      return {
        ...result,
        content: [...result.content, { type: 'text' as const, text: JSON.stringify({ specsVersion: await versionOf() }) }],
      }
    },
  }))
}

/** Filter a tool list to the names an agent may call. Never taken from the tool arguments. */
export function pick(tools: ToolDef[], names: readonly string[]): ToolDef[] {
  const wanted = new Set(names)
  return tools.filter((tool) => wanted.has(tool.name))
}

/** The `mcp__blueprints__`-qualified names, for the SDK's allowedTools. */
export function qualified(names: readonly string[]): string[] {
  return names.map((name) => `mcp__blueprints__${name}`)
}
