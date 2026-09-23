/**
 * SqlSpecStore slice 1: the reads, id allocation, and simple creates, against an in-memory DB.
 *
 * What is exercised is what has a create path in slice 1 — changesets (pending), questions, and
 * expectations (live, split into published vs drafts) — plus id allocation and projectInfo. Terms
 * and the resolved partitions (applied/rejected/retired) have no create path until slice 2's state
 * transitions, so here they are only asserted empty; they get populated tests when apply/reject/
 * retire land. The partitioning logic itself mirrors FileSystemSpecStore.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Answer, Changeset, Expectation, Question, Scenario, Term } from '@abseed/spectra-core'
import { glossaryVersion } from '@abseed/spectra-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqlSpecStore } from './sqlSpecStore.js'

let store: SqlSpecStore
beforeEach(() => {
  store = new SqlSpecStore(':memory:', 'proj-1')
})

const changeset = (id: string, over: Partial<Changeset> = {}): Changeset => ({
  id,
  summary: 'a change',
  ops: [],
  tests: [],
  ...over,
})
const question = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  asks: 'Q?',
  because: 'the spec is silent',
  raisedBy: { pass: 'implementation', terms: ['Task'] },
  options: [],
  answer: null,
  ...over,
})
const expectation = (id: string, over: Partial<Expectation> = {}): Expectation => ({
  id,
  kind: 'functional',
  terms: ['Task'],
  given: '',
  expect: 'something holds',
  raisedBy: { pass: 'implementation' },
  supersededBy: null,
  contested: [],
  ...over,
})
const term = (name: string): Term => ({ name, type: 'entity', spec: `A ${name}.`, parent: null, tags: [], attributes: [] })
const answer: Answer = { chose: null, note: 'settled in prose', answeredAt: '2026-01-01T00:00:00.000Z' }
const scenario = (id: string, over: Partial<Scenario> = {}): Scenario => ({
  id,
  title: 'a situation',
  terms: ['Task'],
  given: '',
  steps: [],
  expect: ['something holds'],
  raisedBy: { pass: 'usage' },
  ...over,
})

describe('SqlSpecStore scenarios (v1)', () => {
  it('adds, reads back in id order, finds by id, and allocates the next id', async () => {
    expect((await store.readScenarios()).scenarios).toEqual([])
    expect(await store.nextScenarioId()).toBe('s-001')

    await store.addScenario(scenario('s-001'))
    await store.addScenario(scenario('s-002', { title: 'another' }))

    const { scenarios } = await store.readScenarios()
    expect(scenarios.map((s) => s.id)).toEqual(['s-001', 's-002'])
    expect((await store.findScenario('s-002'))?.title).toBe('another')
    expect(await store.findScenario('s-404')).toBeNull()
    expect(await store.nextScenarioId()).toBe('s-003')
  })
})

describe('SqlSpecStore.projectInfo', () => {
  it('falls back to a neutral default when unset', async () => {
    const info = await store.projectInfo()
    expect(info.name).toBe('Untitled project')
    expect(info.name).not.toMatch(/todo/i)
  })
  it('returns the set identity', async () => {
    store.setProjectInfo({ name: 'Acme', domain: 'a billing system' })
    expect(await store.projectInfo()).toEqual({ name: 'Acme', domain: 'a billing system' })
  })
  it('round-trips the System Brief; empty clears it (GH #143)', async () => {
    store.setProjectInfo({ name: 'Acme', domain: 'a billing system' })
    await store.setProjectBrief('An API, no UI.')
    expect(await store.projectInfo()).toEqual({ name: 'Acme', domain: 'a billing system', brief: 'An API, no UI.' })
    await store.setProjectBrief('   ')
    expect((await store.projectInfo()).brief).toBeUndefined()
  })
})

describe('SqlSpecStore reads (empty)', () => {
  it('returns the partitioned shapes empty', async () => {
    expect(await store.readTerms()).toEqual({ terms: [], problems: [] })
    expect(await store.readChangesets()).toEqual({ changesets: [], applied: [], rejected: [], problems: [] })
    expect(await store.readQuestions()).toEqual({ questions: [], problems: [] })
    expect(await store.readExpectations()).toEqual({ expectations: [], drafts: [], retired: [], problems: [] })
  })
})

describe('SqlSpecStore changesets', () => {
  it('adds a pending changeset, reads it back, finds it by id', async () => {
    await store.addChangeset(changeset('chat-001', { summary: 'first' }))
    const feed = await store.readChangesets()
    expect(feed.changesets.map((c) => c.id)).toEqual(['chat-001'])
    expect(feed.applied).toEqual([])
    expect(feed.rejected).toEqual([])
    expect((await store.findChangeset('chat-001'))?.summary).toBe('first')
    expect(await store.findChangeset('nope')).toBeNull()
  })
})

describe('SqlSpecStore questions', () => {
  it('adds and reads a question, finds it', async () => {
    await store.addQuestion(question('q-001'))
    expect((await store.readQuestions()).questions.map((q) => q.id)).toEqual(['q-001'])
    expect((await store.findQuestion('q-001'))?.asks).toBe('Q?')
    expect(await store.findQuestion('q-999')).toBeNull()
  })
})

describe('SqlSpecStore expectations', () => {
  it('splits live into published vs drafts; retired is empty', async () => {
    await store.addExpectation(expectation('e-001'))
    await store.addExpectation(expectation('e-002', { status: 'draft' }))
    const feed = await store.readExpectations()
    expect(feed.expectations.map((e) => e.id)).toEqual(['e-001'])
    expect(feed.drafts.map((e) => e.id)).toEqual(['e-002'])
    expect(feed.retired).toEqual([])
    expect((await store.findExpectation('e-002'))?.status).toBe('draft')
  })
})

describe('SqlSpecStore id allocation', () => {
  it('increments per collection over every row, tolerating gaps', async () => {
    expect(await store.nextChangesetId()).toBe('chat-001')
    await store.addChangeset(changeset('chat-003'))
    expect(await store.nextChangesetId()).toBe('chat-004')

    expect(await store.nextQuestionId()).toBe('q-001')
    await store.addQuestion(question('q-002'))
    expect(await store.nextQuestionId()).toBe('q-003')

    await store.addExpectation(expectation('e-005'))
    expect(await store.nextExpectationId()).toBe('e-006')
  })
})

describe('SqlSpecStore project scoping', () => {
  it('keeps two projects in one database isolated', async () => {
    // One shared database file (an in-memory DB is per-connection, so use a temp file).
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tb-sql-')), 'specs.db')
    const one = new SqlSpecStore(file, 'proj-1')
    const two = new SqlSpecStore(file, 'proj-2')

    one.setProjectInfo({ name: 'One', domain: 'first' })
    two.setProjectInfo({ name: 'Two', domain: 'second' })
    await one.addChangeset(changeset('chat-001', { summary: 'only in one' }))

    expect((await one.projectInfo()).name).toBe('One')
    expect((await two.projectInfo()).name).toBe('Two')
    expect((await one.readChangesets()).changesets.map((c) => c.id)).toEqual(['chat-001'])
    expect((await two.readChangesets()).changesets).toEqual([])
    // The same id is free in the other project, and ids are allocated per project.
    expect(await two.nextChangesetId()).toBe('chat-001')
    expect(await one.nextChangesetId()).toBe('chat-002')

    one.close()
    two.close()
  })
})

describe('SqlSpecStore commitApplication', () => {
  it('reconciles terms and moves the changeset pending → applied atomically', async () => {
    await store.addChangeset(changeset('chat-001', { summary: 'add Widget' }))
    const result = await store.commitApplication({
      changesetId: 'chat-001',
      nextTerms: [term('Widget')],
      appliedOps: [],
      remainingOps: [],
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    if ('conflict' in result) throw new Error('unexpected conflict')
    expect(result.written).toEqual(['Widget'])
    const feed = await store.readChangesets()
    expect(feed.changesets).toEqual([]) // no remaining ops → pending gone
    expect(feed.applied.map((c) => c.id)).toEqual(['chat-001'])
    expect((await store.readTerms()).terms.map((t) => t.name)).toEqual(['Widget'])
  })

  it('keeps a pending remainder and deletes terms that did not survive', async () => {
    await store.addChangeset(changeset('chat-001'))
    await store.commitApplication({
      changesetId: 'chat-001',
      nextTerms: [term('A'), term('B')],
      appliedOps: [],
      remainingOps: [],
      appliedAt: 't1',
    })
    // A second changeset, applied partially, dropping term B.
    await store.addChangeset(changeset('chat-002'))
    await store.commitApplication({
      changesetId: 'chat-002',
      nextTerms: [term('A')],
      appliedOps: [],
      remainingOps: [{ op: 'remove_entity', term: 'Z' }],
      appliedAt: 't2',
    })
    expect((await store.readTerms()).terms.map((t) => t.name)).toEqual(['A'])
    const feed = await store.readChangesets()
    expect(feed.changesets.map((c) => c.id)).toEqual(['chat-002']) // remainder stays pending
    expect(feed.applied.map((c) => c.id).sort()).toEqual(['chat-001', 'chat-002'])
  })
})

describe('SqlSpecStore commitApplication — optimistic concurrency (baseVersion CAS, GH #93)', () => {
  it('commits when baseVersion matches the current glossary', async () => {
    await store.addChangeset(changeset('chat-001'))
    const base = glossaryVersion((await store.readTerms()).terms) // the empty glossary's version
    const result = await store.commitApplication({
      changesetId: 'chat-001',
      nextTerms: [term('Widget')],
      appliedOps: [],
      remainingOps: [],
      appliedAt: 't',
      baseVersion: base,
    })
    expect('conflict' in result).toBe(false)
    expect((await store.readTerms()).terms.map((t) => t.name)).toEqual(['Widget'])
  })

  it('refuses, and writes nothing, when the glossary moved past baseVersion', async () => {
    await store.addChangeset(changeset('chat-001'))
    const staleBase = glossaryVersion((await store.readTerms()).terms) // version of the EMPTY glossary
    await store.commitApplication({ changesetId: 'chat-001', nextTerms: [term('Widget')], appliedOps: [], remainingOps: [], appliedAt: 't1' })

    // A second apply computed against the now-stale base must be refused.
    await store.addChangeset(changeset('chat-002'))
    const result = await store.commitApplication({
      changesetId: 'chat-002',
      nextTerms: [term('Widget'), term('Gadget')],
      appliedOps: [],
      remainingOps: [],
      appliedAt: 't2',
      baseVersion: staleBase,
    })
    expect('conflict' in result).toBe(true)
    if ('conflict' in result) expect(result.currentVersion).toBe(glossaryVersion((await store.readTerms()).terms))
    // Nothing landed: Gadget absent, chat-002 still pending.
    expect((await store.readTerms()).terms.map((t) => t.name)).toEqual(['Widget'])
    expect((await store.readChangesets()).changesets.map((c) => c.id)).toEqual(['chat-002'])
  })

  it('interleaved applies against the same base: the first wins, the second conflicts', async () => {
    await store.addChangeset(changeset('chat-001'))
    await store.addChangeset(changeset('chat-002'))
    const base = glossaryVersion((await store.readTerms()).terms)
    const first = await store.commitApplication({ changesetId: 'chat-001', nextTerms: [term('A')], appliedOps: [], remainingOps: [], appliedAt: 't1', baseVersion: base })
    const second = await store.commitApplication({ changesetId: 'chat-002', nextTerms: [term('B')], appliedOps: [], remainingOps: [], appliedAt: 't2', baseVersion: base })
    expect('conflict' in first).toBe(false)
    expect('conflict' in second).toBe(true)
    expect((await store.readTerms()).terms.map((t) => t.name)).toEqual(['A']) // B was refused
  })
})

describe('SqlSpecStore rejectChangeset / markImplemented', () => {
  it('rejects a pending changeset; returns null when none is pending', async () => {
    await store.addChangeset(changeset('chat-001'))
    expect(await store.rejectChangeset('chat-001')).toMatch(/rejected/)
    const feed = await store.readChangesets()
    expect(feed.changesets).toEqual([])
    expect(feed.rejected.map((c) => c.id)).toEqual(['chat-001'])
    expect(await store.rejectChangeset('chat-001')).toBeNull()
  })

  it('marks an applied changeset implemented', async () => {
    await store.addChangeset(changeset('chat-001'))
    await store.commitApplication({ changesetId: 'chat-001', nextTerms: [], appliedOps: [], remainingOps: [], appliedAt: 't' })
    expect(await store.markImplemented('chat-001', '2026-02-02')).toMatch(/applied/)
    const applied = (await store.readChangesets()).applied.find((c) => c.id === 'chat-001')
    expect(applied?.implementedAt).toBe('2026-02-02')
    expect(await store.markImplemented('nope', 't')).toBeNull()
  })
})

describe('SqlSpecStore writeAnswer + CAS', () => {
  it('answers a question, bumping rev; not-found for an unknown id', async () => {
    await store.addQuestion(question('q-001'))
    const r = await store.writeAnswer('q-001', answer)
    expect(r).toEqual({ ok: true, rev: 2, at: 'q-001' })
    expect((await store.findQuestion('q-001'))?.answer?.note).toBe('settled in prose')
    expect(await store.writeAnswer('q-404', answer)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('refuses a stale expectedRev as a conflict, naming the current rev', async () => {
    await store.addQuestion(question('q-001'))
    await store.writeAnswer('q-001', answer) // rev 1 → 2
    expect(await store.writeAnswer('q-001', answer, 1)).toEqual({ ok: false, reason: 'conflict', currentRev: 2 })
    expect(await store.writeAnswer('q-001', answer, 2)).toMatchObject({ ok: true, rev: 3 })
  })
})

describe('SqlSpecStore setQuestionBlocking (GH #137)', () => {
  it('sets then clears blocking, bumping rev; leaves nothing behind when cleared', async () => {
    await store.addQuestion(question('q-001'))
    expect(await store.setQuestionBlocking('q-001', true)).toMatchObject({ ok: true, rev: 2 })
    expect((await store.findQuestion('q-001'))?.blocking).toBe(true)
    expect(await store.setQuestionBlocking('q-001', false)).toMatchObject({ ok: true, rev: 3 })
    expect((await store.findQuestion('q-001'))?.blocking).toBeUndefined()
  })

  it('reports not-found for an unknown id and guards on expectedRev', async () => {
    expect(await store.setQuestionBlocking('q-404', true)).toEqual({ ok: false, reason: 'not-found' })
    await store.addQuestion(question('q-001'))
    await store.setQuestionBlocking('q-001', true) // rev 1 → 2
    expect(await store.setQuestionBlocking('q-001', true, 1)).toEqual({ ok: false, reason: 'conflict', currentRev: 2 })
  })
})

describe('SqlSpecStore retire / rewrite expectation + CAS', () => {
  it('retires a live expectation, bumping rev; guards on expectedRev', async () => {
    await store.addExpectation(expectation('e-001'))
    const r = await store.retireExpectation('e-001', expectation('e-001', { supersededBy: 'e-002' }))
    expect(r).toMatchObject({ ok: true, rev: 2 })
    const feed = await store.readExpectations()
    expect(feed.expectations).toEqual([])
    expect(feed.retired.map((e) => e.id)).toEqual(['e-001'])
    // already retired → not live → not-found
    expect(await store.retireExpectation('e-001', expectation('e-001'))).toEqual({ ok: false, reason: 'not-found' })
  })

  it('rewrites a live expectation in place; stale rev conflicts', async () => {
    await store.addExpectation(expectation('e-001'))
    const r = await store.rewriteExpectation(expectation('e-001', { expect: 'reworded' }), 1)
    expect(r).toMatchObject({ ok: true, rev: 2 })
    expect((await store.findExpectation('e-001'))?.expect).toBe('reworded')
    expect(await store.rewriteExpectation(expectation('e-001'), 1)).toEqual({ ok: false, reason: 'conflict', currentRev: 2 })
  })
})
