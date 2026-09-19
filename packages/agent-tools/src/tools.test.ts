/**
 * The pure tool layer, exercised against a tiny in-memory store: the tools construct, their handlers
 * run, `withVersion` stamps every result, `pick` filters to an agent's names, and — the point of the
 * whole per-user model — a write is attributed to the `author` the caller passed, never to the tool
 * arguments.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Author, Changeset, Question, Scenario, SpecStore, Term, TranscriptStore } from '@abseed/spectra-core'
import { pick, pureTools, qualified, withVersion } from './tools.js'

const term = (name: string): Term => ({ name, type: 'entity', spec: `A ${name}`, parent: null, attributes: [], tags: [] })

/** A minimal SpecStore: enough for the pure tools, capturing what gets written. */
function fakeStore(captured: { changeset?: Changeset; question?: Question; scenario?: Scenario }) {
  const empty = { problems: [] as never[] }
  return {
    readTerms: async () => ({ terms: [term('Task'), term('Project')], ...empty }),
    readQuestions: async () => ({ questions: [] as Question[], ...empty }),
    readChangesets: async () => ({ changesets: [] as Changeset[], applied: [] as never[], ...empty }),
    readExpectations: async () => ({ expectations: [] as never[], retired: [] as never[], ...empty }),
    readScenarios: async () => ({ scenarios: [] as Scenario[], ...empty }),
    nextChangesetId: async () => 'cs-001',
    addChangeset: async (cs: Changeset) => {
      captured.changeset = cs
      return 'cs-001.json'
    },
    nextQuestionId: async () => 'q-001',
    addQuestion: async (q: Question) => {
      captured.question = q
      return 'q-001.json'
    },
    nextScenarioId: async () => 's-001',
    addScenario: async (sc: Scenario) => {
      captured.scenario = sc
      return 's-001.json'
    },
  } as unknown as SpecStore
}

const fakeTranscripts = { search: async () => [] } as unknown as TranscriptStore
const author: Author = { kind: 'coder', user: 'usr_42' }
const version = () => Promise.resolve('v-test')

/** Parse a tool result's first content block as JSON. */
async function call(tools: ReturnType<typeof withVersion>, name: string, args: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === name)!
  const result = await tool.handler(args, undefined)
  return {
    body: JSON.parse(result.content[0]!.text),
    version: JSON.parse(result.content[result.content.length - 1]!.text),
  }
}

describe('pure tool layer', () => {
  it('read_glossary returns terms and every result carries the injected specs version', async () => {
    const tools = withVersion(pureTools(fakeStore({}), fakeTranscripts, author), version)
    const { body, version: v } = await call(tools, 'read_glossary', {})
    expect(body.terms.map((t: { name: string }) => t.name)).toEqual(['Task', 'Project'])
    expect(v).toEqual({ specsVersion: 'v-test' })
  })

  it('propose_changeset attributes the write to the caller-supplied author, not the args', async () => {
    const captured: { changeset?: Changeset } = {}
    const tools = withVersion(pureTools(fakeStore(captured), fakeTranscripts, author), version)
    const { body } = await call(tools, 'propose_changeset', {
      summary: 'Add Foo',
      ops: [{ op: 'add_entity', term: 'Foo', spec: 'A foo' }],
      tests: ['a Foo can be named'],
    })
    expect(body.proposed).toBe('cs-001')
    expect(captured.changeset?.author).toEqual({ kind: 'coder', user: 'usr_42' })
  })

  it('raise_question attributes the write to the author too', async () => {
    const captured: { question?: Question } = {}
    const tools = withVersion(pureTools(fakeStore(captured), fakeTranscripts, author), version)
    const { body } = await call(tools, 'raise_question', {
      asks: 'Should a Task belong to exactly one Project?',
      because: 'The spec says "a Task is filed under a Project" but also "a Task may be loose".',
      pass: 'review',
      terms: ['Task', 'Project'],
      options: [{ label: 'exactly one' }, { label: 'zero or one' }],
    })
    expect(body.raised).toBe('q-001')
    expect(captured.question?.author).toEqual({ kind: 'coder', user: 'usr_42' })
  })

  it('raise_scenario writes a cross-entity scenario, attributed to the author', async () => {
    const captured: { scenario?: Scenario } = {}
    const tools = withVersion(pureTools(fakeStore(captured), fakeTranscripts, author), version)
    const { body } = await call(tools, 'raise_scenario', {
      title: 'Two shoppers race for the last unit',
      terms: ['Task', 'Project'],
      given: 'one unit left',
      steps: ['both check out at the same instant'],
      expect: ['exactly one succeeds'],
      pass: 'usage',
    })
    expect(body.raised).toBe('s-001')
    expect(body.file).toBe('specs/scenarios/s-001.json')
    expect(captured.scenario?.author).toEqual({ kind: 'coder', user: 'usr_42' })
    expect(captured.scenario?.terms).toEqual(['Task', 'Project'])
  })

  it('raise_scenario refuses one that names no term, writing nothing', async () => {
    const captured: { scenario?: Scenario } = {}
    const tools = withVersion(pureTools(fakeStore(captured), fakeTranscripts, author), version)
    const { body } = await call(tools, 'raise_scenario', {
      title: 'No terms',
      terms: [],
      expect: ['something'],
      pass: 'usage',
    })
    expect(body.error).toMatch(/at least one glossary term/)
    expect(captured.scenario).toBeUndefined()
  })

  it('pick filters to an agent’s names, and qualified prefixes them', () => {
    const tools = pureTools(fakeStore({}), fakeTranscripts, author)
    expect(pick(tools, ['read_glossary', 'propose_changeset']).map((t) => t.name)).toEqual(['read_glossary', 'propose_changeset'])
    expect(qualified(['read_glossary'])).toEqual(['mcp__blueprints__read_glossary'])
  })

  it('a tool handler runs exactly once per call under withVersion (no double-dispatch)', async () => {
    const store = fakeStore({})
    const spy = vi.spyOn(store, 'readTerms')
    const tools = withVersion(pureTools(store, fakeTranscripts, author), version)
    await call(tools, 'read_glossary', {})
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
