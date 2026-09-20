import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppliedChange,
  type FireResult,
  TimerScheduler,
  describeApplied,
  implementInstruction,
} from './implementationScheduler.js'

const change = (changesetId: string, ...written: string[]): AppliedChange => ({ changesetId, written, deleted: [] })

describe('TimerScheduler', () => {
  let clock = 0
  const now = () => clock
  const advance = (ms: number) => {
    clock += ms
    vi.advanceTimersByTime(ms)
  }

  beforeEach(() => {
    clock = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires one batch after a quiet window, and opens the batch exactly once', async () => {
    const fired: AppliedChange[][] = []
    let opens = 0
    const scheduler = new TimerScheduler(
      {
        onOpen: () => {
          opens += 1
        },
        onFire: (_project, changes) => {
          fired.push(changes)
          return 'sent'
        },
      },
      { windowMs: 1000, maxWaitMs: 10_000 },
      now,
    )

    scheduler.noteApplied('p', change('cs-1', 'Widget'))
    advance(400)
    scheduler.noteApplied('p', change('cs-2', 'Cart')) // resets the window
    advance(999)
    expect(fired).toHaveLength(0) // not yet — the second apply pushed it out
    advance(1)
    await vi.runAllTicks()

    expect(opens).toBe(1) // one batch, one countdown
    expect(fired).toHaveLength(1)
    expect(fired[0]!.map((c) => c.changesetId)).toEqual(['cs-1', 'cs-2']) // both, batched
  })

  it('dedupes a re-applied changeset within a batch', async () => {
    const fired: AppliedChange[][] = []
    const scheduler = new TimerScheduler(
      { onFire: (_p, c) => (fired.push(c), 'sent') },
      { windowMs: 1000, maxWaitMs: 10_000 },
      now,
    )
    scheduler.noteApplied('p', change('cs-1', 'Widget'))
    advance(200)
    scheduler.noteApplied('p', change('cs-1', 'Widget', 'Cart')) // same id, newer footprint
    advance(1000)
    await vi.runAllTicks()

    expect(fired[0]).toHaveLength(1)
    expect(fired[0]![0]!.written).toEqual(['Widget', 'Cart']) // latest wins
  })

  it('caps the wait so a steady drip still fires (maxWaitMs)', async () => {
    const fired: AppliedChange[][] = []
    const scheduler = new TimerScheduler(
      { onFire: (_p, c) => (fired.push(c), 'sent') },
      { windowMs: 1000, maxWaitMs: 2500 },
      now,
    )
    scheduler.noteApplied('p', change('cs-1'))
    advance(900)
    scheduler.noteApplied('p', change('cs-2'))
    advance(900) // 1800 elapsed, window would reset to 2700 but cap is 2500
    scheduler.noteApplied('p', change('cs-3'))
    advance(700) // reaches the 2500 cap
    await vi.runAllTicks()

    expect(fired).toHaveLength(1)
    expect(fired[0]!.map((c) => c.changesetId)).toEqual(['cs-1', 'cs-2', 'cs-3'])
  })

  it("retries the same batch without re-announcing when onFire asks to (e.g. @coder busy)", async () => {
    const fired: AppliedChange[][] = []
    let opens = 0
    const results: FireResult[] = ['retry', 'sent']
    const scheduler = new TimerScheduler(
      {
        onOpen: () => {
          opens += 1
        },
        onFire: (_p, c) => {
          fired.push(c)
          return results.shift() ?? 'sent'
        },
      },
      { windowMs: 1000, maxWaitMs: 100_000 },
      now,
    )
    scheduler.noteApplied('p', change('cs-1', 'Widget'))
    advance(1000)
    await vi.runAllTicks()
    expect(fired).toHaveLength(1) // first attempt, said 'retry'

    advance(1000)
    await vi.runAllTicks()
    expect(fired).toHaveLength(2) // retried after another window
    expect(opens).toBe(1) // but only announced once
    expect(fired[1]!.map((c) => c.changesetId)).toEqual(['cs-1']) // same batch
  })

  it('drops the batch and does not retry when onFire returns dropped', async () => {
    let fires = 0
    const scheduler = new TimerScheduler(
      { onFire: () => (fires++, 'dropped') },
      { windowMs: 1000, maxWaitMs: 100_000 },
      now,
    )
    scheduler.noteApplied('p', change('cs-1'))
    advance(1000)
    await vi.runAllTicks()
    advance(5000)
    await vi.runAllTicks()
    expect(fires).toBe(1) // fired once, dropped, never came back
  })

  it('keeps projects independent', async () => {
    const fired: Record<string, number> = {}
    const scheduler = new TimerScheduler(
      { onFire: (project) => ((fired[project] = (fired[project] ?? 0) + 1), 'sent') },
      { windowMs: 1000, maxWaitMs: 10_000 },
      now,
    )
    scheduler.noteApplied('a', change('cs-1'))
    scheduler.noteApplied('b', change('cs-2'))
    advance(1000)
    await vi.runAllTicks()
    expect(fired).toEqual({ a: 1, b: 1 })
  })

  it('cancel drops an armed batch before it fires', async () => {
    let fires = 0
    const scheduler = new TimerScheduler({ onFire: () => (fires++, 'sent') }, { windowMs: 1000, maxWaitMs: 10_000 }, now)
    scheduler.noteApplied('p', change('cs-1'))
    scheduler.cancel('p')
    advance(2000)
    await vi.runAllTicks()
    expect(fires).toBe(0)
  })
})

describe('text builders', () => {
  it('rolls up applied changes readably', () => {
    expect(describeApplied([{ changesetId: 'cs-1', written: ['Widget', 'Cart'], deleted: [] }])).toBe('cs-1 (Widget, Cart)')
    expect(
      describeApplied([
        { changesetId: 'cs-1', written: ['Widget'], deleted: [] },
        { changesetId: 'cs-2', written: [], deleted: ['Order'] },
      ]),
    ).toBe('cs-1 (Widget) and cs-2 (Order)')
    expect(describeApplied([{ changesetId: 'cs-9', written: [], deleted: [] }])).toBe('cs-9') // no terms named
  })

  it('names the changesets in the instruction and tells @coder to run the drift check', () => {
    const instruction = implementInstruction([{ changesetId: 'cs-1', written: ['Widget'], deleted: [] }])
    expect(instruction).toContain('cs-1 (Widget)')
    expect(instruction).toContain('drift check')
  })
})
