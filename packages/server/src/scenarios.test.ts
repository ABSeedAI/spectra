/**
 * raiseScenario over a FileSystemSpecStore — the same shape as raise.test.ts (raiseQuestion).
 * Scenarios are add-only in v1: raised, validated before disk, numbered s-NNN, read back whole.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import type { Author } from '@abseed/spectra-core'
import { raiseScenario } from '@abseed/spectra-core'

const BY: Author = { kind: 'human' }
let store: FileSystemSpecStore

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tb-scenario-'))
  store = new FileSystemSpecStore(root, 'proj')
})

const BASE = {
  title: 'Two shoppers race for the last unit',
  terms: ['SKU', 'Reservation'],
  given: 'one unit of SKU X; two shoppers hold it in their cart',
  steps: ['both check out at the same instant', 'one payment succeeds, one fails'],
  expect: ['exactly one Reservation is created'],
  pass: 'usage',
}

describe('raiseScenario', () => {
  it('writes a scenario, stamps author + origin, and numbers from s-001', async () => {
    const outcome = await raiseScenario(store, BASE, BY)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.id).toBe('s-001')
    expect(outcome.file).toMatch(/^s-001-two-shoppers-race-for-the-last-unit\.json$/)

    const { scenarios } = await store.readScenarios()
    expect(scenarios).toHaveLength(1)
    expect(scenarios[0]!.author).toEqual({ kind: 'human' })
    expect(scenarios[0]!.raisedBy).toEqual({ pass: 'usage' })
    expect(scenarios[0]!.terms).toEqual(['SKU', 'Reservation'])
    expect(scenarios[0]!.expect).toEqual(['exactly one Reservation is created'])
  })

  it('numbers the next scenario above the highest already there', async () => {
    const second = await raiseScenario(store, { ...BASE, title: 'A different situation' }, BY)
    expect(second.ok && second.id).toBe('s-002')
  })

  it('refuses a scenario that names no term — cross-entity by definition — and writes nothing', async () => {
    const before = (await store.readScenarios()).scenarios.length
    const outcome = await raiseScenario(store, { ...BASE, title: 'No terms', terms: [] }, BY)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/at least one glossary term/)
    expect((await store.readScenarios()).scenarios).toHaveLength(before)
  })

  it('refuses a scenario with no assertions', async () => {
    const outcome = await raiseScenario(store, { ...BASE, title: 'No assertions', expect: [] }, BY)
    expect(outcome.ok).toBe(false)
  })

  it('finds a raised scenario by id', async () => {
    const found = await store.findScenario('s-001')
    expect(found?.title).toBe('Two shoppers race for the last unit')
  })
})
