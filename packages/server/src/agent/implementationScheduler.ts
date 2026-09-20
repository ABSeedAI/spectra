/**
 * The debounce that turns a burst of applied changesets into one @coder implementation turn.
 *
 * Without it, every changeset a human applies has to be followed by a hand-typed "specs changed,
 * please update the code" — and applying three in a row means three pings, or one the human has to
 * remember after the last. This buffers instead: each apply (re)arms a per-project timer, and when
 * it goes quiet for `windowMs` (or `maxWaitMs` has elapsed since the batch opened, so a steady drip
 * still fires) the whole batch fires as a single turn. Applying another changeset inside the window
 * resets the timer, which is exactly the batching we want.
 *
 * The interface is the seam. `TimerScheduler` holds the timers in this process — right for the open
 * server, which is one long-lived process. A deployment that runs many instances, or wants the clock
 * to survive a restart, implements {@link ImplementationScheduler} with its own timer facility; same
 * shape, different clock. This file names no forge and no specific timer service on purpose.
 *
 * Timing only. *What to say and run* when a batch opens or fires is the caller's policy, injected as
 * {@link SchedulerHandlers}: `onOpen` (a fresh batch just started — post the "starting in ~Ns"
 * notice) and `onFire` (the batch is ready — start the turn). `onFire` returns whether it sent,
 * wants a retry (e.g. @coder is mid-run, so wait and try again), or dropped the batch (no session is
 * eligible), so the mechanism never learns the policy.
 */

/** One applied changeset's footprint — the terms it wrote or removed, so a fired batch can name them. */
export interface AppliedChange {
  changesetId: string
  written: string[]
  deleted: string[]
}

/** What `onFire` reports back, which decides whether the batch is done or waits for another window. */
export type FireResult = 'sent' | 'retry' | 'dropped'

export interface ImplementationScheduler {
  /** A term-changing changeset landed on a project's glossary. Opens or re-arms that project's batch. */
  noteApplied(projectId: string, change: AppliedChange): void
  /** Drop a project's armed batch (its project is gone, say) without firing it. */
  cancel(projectId: string): void
  /** Stop every timer — a clean shutdown or a test teardown. */
  cancelAll(): void
}

export interface SchedulerConfig {
  /** Quiet period after the last apply before the batch fires. */
  windowMs: number
  /** Cap from the batch opening, so a steady drip of applies still fires rather than resetting forever. */
  maxWaitMs: number
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  windowMs: 60_000,
  maxWaitMs: 5 * 60_000,
}

export interface SchedulerHandlers {
  /**
   * A batch just opened (idle → active). Best-effort side effect — post the countdown notice. Not
   * called on a retry re-arm, so @coder does not announce itself twice for one batch.
   */
  onOpen?: (projectId: string) => void | Promise<void>
  /** The batch is ready. Start the turn and report how it went (see {@link FireResult}). */
  onFire: (projectId: string, changes: AppliedChange[]) => FireResult | Promise<FireResult>
}

interface Batch {
  /** Keyed by changeset id so a re-applied or re-queued changeset does not appear twice. */
  changes: Map<string, AppliedChange>
  timer: ReturnType<typeof setTimeout>
  openedAt: number
}

export class TimerScheduler implements ImplementationScheduler {
  private readonly batches = new Map<string, Batch>()

  constructor(
    private readonly handlers: SchedulerHandlers,
    private readonly config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
    /** Injected for tests; real code uses the wall clock. */
    private readonly now: () => number = Date.now,
  ) {}

  noteApplied(projectId: string, change: AppliedChange): void {
    const existing = this.batches.get(projectId)
    if (existing) {
      existing.changes.set(change.changesetId, change)
      this.arm(projectId, existing)
      return
    }
    const batch: Batch = { changes: new Map([[change.changesetId, change]]), timer: this.arm(projectId), openedAt: this.now() }
    this.batches.set(projectId, batch)
    void this.handlers.onOpen?.(projectId)
  }

  cancel(projectId: string): void {
    const batch = this.batches.get(projectId)
    if (!batch) return
    clearTimeout(batch.timer)
    this.batches.delete(projectId)
  }

  cancelAll(): void {
    for (const batch of this.batches.values()) clearTimeout(batch.timer)
    this.batches.clear()
  }

  /**
   * Set (or reset) a batch's timer. Overloaded so the first arm — before the batch object exists —
   * can hand back the timer to store on it; later arms clear the batch's own timer and replace it.
   * The delay is the window, capped so it never pushes the fire past `openedAt + maxWaitMs`.
   */
  private arm(projectId: string, batch?: Batch): ReturnType<typeof setTimeout> {
    if (batch) clearTimeout(batch.timer)
    const elapsed = batch ? this.now() - batch.openedAt : 0
    const delay = Math.max(0, Math.min(this.config.windowMs, this.config.maxWaitMs - elapsed))
    const timer = setTimeout(() => void this.fire(projectId), delay)
    // A pending debounce timer must not, by itself, keep the process alive.
    timer.unref?.()
    if (batch) batch.timer = timer
    return timer
  }

  private async fire(projectId: string): Promise<void> {
    const batch = this.batches.get(projectId)
    if (!batch) return
    this.batches.delete(projectId)

    let result: FireResult
    try {
      result = await this.handlers.onFire(projectId, [...batch.changes.values()])
    } catch {
      // A handler that threw is treated as "could not send" rather than crashing the timer path;
      // retrying would risk a tight loop on a persistent error, so the batch is dropped.
      result = 'dropped'
    }

    if (result !== 'retry') return
    // Re-open the SAME batch for another window without calling onOpen (no second countdown), so a
    // batch that could not send because @coder was busy waits and tries again once it is free.
    const retry: Batch = { changes: batch.changes, timer: this.arm(projectId), openedAt: this.now() }
    this.batches.set(projectId, retry)
  }
}

/** "chat-004 (Widget, Cart) and chat-005 (Order)" — a human-readable roll-up of a fired batch. */
export function describeApplied(changes: AppliedChange[]): string {
  const parts = changes.map((change) => {
    const terms = [...change.written, ...change.deleted]
    return terms.length > 0 ? `${change.changesetId} (${terms.join(', ')})` : change.changesetId
  })
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The countdown @coder posts when a batch opens — the "I'll start in ~Ns" acknowledgement. */
export function countdownNotice(windowMs: number): string {
  return `Specs changed — I'll start updating the code in about ${Math.round(windowMs / 1000)}s (batching any further edits you apply).`
}

/** The lead-in @coder posts when the batch fires, naming what it is about to implement. */
export function firingNotice(changes: AppliedChange[]): string {
  return `Specs changed: ${describeApplied(changes)}. Updating the code to match.`
}

/** The instruction handed to @coder for the turn — not shown as a human message; this is what it acts on. */
export function implementInstruction(changes: AppliedChange[]): string {
  return [
    `The glossary changed. These changesets were just applied: ${describeApplied(changes)}.`,
    'Update the code to reflect the current specs — use the `// implements:` markers to find what each changed term affects — and run the drift check when you are done.',
    'If a change forces a decision the specs do not settle, raise a question rather than guessing.',
  ].join(' ')
}
