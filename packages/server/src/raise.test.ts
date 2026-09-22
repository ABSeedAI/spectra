import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import type { Author } from '@abseed/spectra-core'
import { raiseQuestion } from '@abseed/spectra-core'

const BY: Author = { kind: 'human' }

// The store is constructor-injected now, so the temp glossary is just a directory we point a
// FileSystemSpecStore at — no module-load env dance.
let specs: string
let store: FileSystemSpecStore

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tb-raise-'))
  specs = path.join(root, 'proj', 'specs') // the store scopes to <root>/<projectId>/specs now
  await mkdir(path.join(specs, 'terms'), { recursive: true })
  await mkdir(path.join(specs, 'questions'), { recursive: true })
  await writeFile(
    path.join(specs, 'terms', 'task.json'),
    JSON.stringify({ name: 'Task', type: 'entity', spec: 'A task.', parent: null, tags: [], attributes: [] }),
  )
  store = new FileSystemSpecStore(root, 'proj')
})

const BASE = {
  asks: 'Can a Task move between Projects?',
  because: 'Task.project is declared as a single ref:Project and no function changes it.',
  pass: 'implementation',
  terms: ['Task'],
}

async function questionFiles(): Promise<string[]> {
  return (await readdir(path.join(specs, 'questions'))).sort()
}

describe('raiseQuestion', () => {
  it('writes a question with no options — some can only be answered in prose', async () => {
    const outcome = await raiseQuestion(store, { ...BASE, options: [] }, BY)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.id).toBe('q-001')

    const written = JSON.parse(await readFile(path.join(specs, 'questions', outcome.file), 'utf8'))
    expect(written.answer).toBeNull()
    expect(written.raisedBy).toEqual({ pass: 'implementation', terms: ['Task'] })
    // Identity is stamped by the caller and persisted alongside the origin.
    expect(written.author).toEqual({ kind: 'human' })
  })

  it('numbers the next question above the highest already there', async () => {
    const second = await raiseQuestion(store, { ...BASE, asks: 'Second question?', options: [] }, BY)
    expect(second.ok && second.id).toBe('q-002')
  })

  it('names the file from the id and the question', async () => {
    const outcome = await raiseQuestion(store, { ...BASE, asks: 'Should a Task have an owner?', options: [] }, BY)
    expect(outcome.ok && outcome.file).toMatch(/^q-003-should-a-task-have-an-owner\.json$/)
  })

  it('keeps a proposal on an option and defaults the others to null', async () => {
    const outcome = await raiseQuestion(store, {
      ...BASE,
      asks: 'Add an owner?',
      options: [
        {
          label: 'Add it',
          proposal: {
            summary: 'Add Task.owner',
            ops: [{ op: 'add_attribute', term: 'Task', attribute: { name: 'owner', valueType: 'string' } }],
            tests: ['a Task can carry an owner'],
          },
        },
        { label: 'Leave it out' },
      ],
    }, BY)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.question.options[0]!.proposal!.ops).toHaveLength(1)
    expect(outcome.question.options[1]!.proposal).toBeNull()
  })

  it('refuses a proposal with an invalid valueType instead of writing it', async () => {
    const before = await questionFiles()
    const outcome = await raiseQuestion(store, {
      ...BASE,
      asks: 'Bad op?',
      options: [
        {
          label: 'Broken',
          proposal: {
            summary: 'Bare term name where a ref belongs',
            ops: [{ op: 'add_attribute', term: 'Task', attribute: { name: 'x', valueType: 'Project' } }],
            tests: [],
          },
        },
      ],
    }, BY)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/ref:Project/)
    expect(await questionFiles()).toEqual(before)
  })

  it('never overwrites an existing file when two questions collide on a name', async () => {
    const first = await raiseQuestion(store, { ...BASE, asks: 'Same wording', options: [] }, BY)
    const second = await raiseQuestion(store, { ...BASE, asks: 'Same wording', options: [] }, BY)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.file).not.toBe(first.file)
    expect(second.id).not.toBe(first.id)
  })

  // GH #137: blocking is an implementation-state signal, so only @coder may originate it.
  it('honours blocking from a coder author', async () => {
    const outcome = await raiseQuestion(store, { ...BASE, asks: 'Blocking one?', options: [], blocking: true }, { kind: 'coder' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.question.blocking).toBe(true)
    const written = JSON.parse(await readFile(path.join(specs, 'questions', outcome.file), 'utf8'))
    expect(written.blocking).toBe(true)
  })

  it('ignores blocking from a non-coder author', async () => {
    const outcome = await raiseQuestion(store, { ...BASE, asks: 'Not blocking?', options: [], blocking: true }, { kind: 'spec' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.question.blocking).toBeUndefined()
  })

  it('leaves blocking off the record when a coder does not set it', async () => {
    const outcome = await raiseQuestion(store, { ...BASE, asks: 'Plain one?', options: [] }, { kind: 'coder' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const written = JSON.parse(await readFile(path.join(specs, 'questions', outcome.file), 'utf8'))
    expect('blocking' in written).toBe(false)
  })

  it('setQuestionBlocking sets then clears the flag, bumping rev', async () => {
    const raised = await raiseQuestion(store, { ...BASE, asks: 'Toggle me?', options: [] }, BY)
    expect(raised.ok).toBe(true)
    if (!raised.ok) return

    const set = await store.setQuestionBlocking(raised.id, true)
    expect(set).toMatchObject({ ok: true })
    let written = JSON.parse(await readFile(path.join(specs, 'questions', raised.file), 'utf8'))
    expect(written.blocking).toBe(true)

    const cleared = await store.setQuestionBlocking(raised.id, false)
    expect(cleared).toMatchObject({ ok: true })
    written = JSON.parse(await readFile(path.join(specs, 'questions', raised.file), 'utf8'))
    expect('blocking' in written).toBe(false)
  })

  it('setQuestionBlocking reports not-found for an unknown id', async () => {
    expect(await store.setQuestionBlocking('q-999', true)).toEqual({ ok: false, reason: 'not-found' })
  })
})
