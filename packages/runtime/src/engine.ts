/**
 * The agent runtime's core loop, with no transport bolted on.
 *
 * This is everything the runtime *is* — running one agent's SDK loop, streaming what it does as
 * events, and blocking on approvals — separated from *how a coordinator reaches it*. It holds the
 * per-session state (open runs, pending approvals, resumable SDK sessions) and exposes three verbs
 * a transport drives it through: `submitTurn`, `submitDecision`, `subscribe`. The HTTP service in
 * {@link ./httpTransport.ts} is one such transport; a coordinator that must dial *out* (a laptop
 * behind NAT reaching a hosted coordinator) is another, and it attaches to this same engine without
 * the loop knowing which.
 *
 * The loop itself is unchanged from when it lived inline with the Express server — it still fetches
 * its profile per run from `SERVER_URL/mcp/<agent>/profile` (so identity comes from the one
 * definition in the Server, not a copy here), still emits into a per-session emitter, and still
 * resolves an approval out of a promise the transport completes. What moved is only the boundary:
 * the `active`-guard + `done` emit that used to sit in the turn handler, and the emitter
 * subscription that used to sit in the stream handler, are now `submitTurn`/`subscribe`, so every
 * transport gets them identically rather than re-implementing the guard.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * Who this agent is — fetched per run, not stored. See {@link ./httpTransport.ts} and the runtime's
 * history: the system prompt and tool list used to live here as a second, drifting copy of the
 * Server's agents.ts; now this asks for them so there is one definition, and the copy an attacker
 * inside the box could edit does not exist.
 */
export interface Profile {
  systemPrompt: string
  builtins: string[]
  autoApprove: string[]
  disallowedTools: string[]
  tools: string[]
}

export interface EngineOptions {
  /** Which agent this runtime is — `coder` or `spec`. Only names the busy message and the logs. */
  agent: string
  /** @coder's cwd and only writable mount; @spec's is unused but must exist for the SDK spawn. */
  appDir: string
  /** The Server's per-project MCP endpoint this runtime's profile fetch and tool calls act on. */
  mcpUrl: string
  /**
   * Build the MCP endpoint for a specific project, for a runtime that serves more than one (a
   * user-global @spec, which picks the project per turn). When a turn carries a projectId and this is
   * set, the run uses it instead of the fixed {@link mcpUrl}; otherwise {@link mcpUrl} stands.
   */
  mcpUrlFor?: (projectId: string) => string
  /**
   * A bearer token sent on the profile fetch and every MCP tool call, when set. In the sandbox the
   * Server trusts the network and this is unset; a hosted coordinator authenticates each call with it
   * (the device token) to resolve the user, so a write is attributed to the human who ran the turn.
   */
  authToken?: string
  /** How long a pending approval waits before it gives up, so a run cannot hang forever. */
  approvalTimeoutMs?: number
}

/** A submitted verb's outcome — `ok: false` carries a human-readable reason a transport can relay. */
export type Result = { ok: true } | { ok: false; error: string }

export interface Engine {
  /**
   * Records nothing; launches the agent. Returns immediately — output arrives over `subscribe`.
   * `projectId` scopes this turn's glossary for a user-global runtime; omitted, the fixed mcpUrl stands.
   */
  submitTurn(sessionId: string, prompt: string, unattended: boolean, projectId?: string): Result
  /** Delivers a human's approval decision to the run blocked on it. */
  submitDecision(approvalId: string, decision: 'allow' | 'deny', note: string | null): Result
  /** Streams a session's events until the returned unsubscribe is called. */
  subscribe(sessionId: string, onEvent: (event: unknown) => void): () => void
  /** The agent's fetched profile — exposed so a transport's health check can report its tools. */
  profile(): Promise<Profile>
}

interface Pending {
  resolve: (allow: { allow: boolean; note: string | null }) => void
  timer: NodeJS.Timeout
}

/**
 * Continue a turn the model cut off at its output limit (GH #156), instead of treating it as finished.
 * A max_tokens cutoff arrives as a *success* result with `stop_reason: 'max_tokens'` (there is no
 * error_max_tokens subtype), so a loop that checks only `subtype` reads a truncated turn as complete —
 * @coder stops mid-edit with nothing written. This mirrors the in-process runner's truncation handling;
 * kept inline because the runtime is standalone (its own lockfile, minimal deps).
 */
const MAX_TOKEN_CONTINUATIONS = 3
const CONTINUATION_PROMPT =
  'Your previous reply was cut off at the output limit before you finished. Continue exactly where you left off and complete it — if you were partway through a tool call or an edit, finish it now. Do not repeat what you already wrote, and do not re-run a tool call that already succeeded.'
function afterTokenResult(subtype: string, stopReason: string | null, continuationsUsed: number): 'done' | 'continue' | 'exhausted' {
  if (!(subtype === 'success' && stopReason === 'max_tokens')) return 'done'
  return continuationsUsed < MAX_TOKEN_CONTINUATIONS ? 'continue' : 'exhausted'
}

export function createEngine(opts: EngineOptions): Engine {
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 15 * 60 * 1000

  const streams = new Map<string, EventEmitter>()
  const awaiting = new Map<string, Pending>()
  const sdkSessions = new Map<string, string>()
  const active = new Set<string>()

  // The agent SDK spawns the `claude` binary with cwd = appDir; Node refuses to spawn into a
  // missing directory. @coder's is a mount that exists; @spec's is unused (no filesystem tools) and
  // may not exist, so ensure it either way — the same reason the in-process path mkdirs it.
  mkdirSync(opts.appDir, { recursive: true })

  function channel(sessionId: string): EventEmitter {
    let emitter = streams.get(sessionId)
    if (!emitter) {
      emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      streams.set(sessionId, emitter)
    }
    return emitter
  }

  function emit(sessionId: string, event: Record<string, unknown>): void {
    channel(sessionId).emit('event', event)
  }

  /** The auth header sent with the profile fetch and MCP calls, or none when no token is configured. */
  const authHeaders: Record<string, string> = opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}

  async function profile(mcpUrl: string): Promise<Profile> {
    const response = await fetch(`${mcpUrl}/profile`, { signal: AbortSignal.timeout(5_000), headers: authHeaders })
    if (!response.ok) throw new Error(`The spec tool answered ${response.status} for the agent profile.`)
    return (await response.json()) as Profile
  }

  /**
   * Blocks the run until a decision is relayed back in — unless the human has said not to for this
   * session.
   *
   * `unattended` is only ever reached because of where this code runs. The card used to carry the
   * entire boundary; in here the container has no route out, no credential, and one writable mount
   * holding code you can rebuild. Approving `npm run typecheck` under those conditions is ceremony,
   * not safety. The spec tool refuses to turn this on for an agent that is not in a container, which
   * is the case where the card really is the only thing.
   *
   * What it does not skip: `disallowedTools`. Those are refused by the SDK before this callback is
   * consulted, so `git commit` and friends stay refused. Skipping review is not granting everything.
   *
   * Every auto-allowed call is still announced and still recorded. Not asking is not the same as not
   * saying — the point is to stop interrupting you, not to work where you cannot see.
   */
  function askPermission(sessionId: string, unattended: boolean) {
    return async (toolName: string, input: Record<string, unknown>) => {
      const approvalId = randomUUID()

      if (unattended) {
        emit(sessionId, { kind: 'auto_approved', approvalId, tool: toolName, input })
        return { behavior: 'allow', updatedInput: input } as const
      }

      emit(sessionId, { kind: 'approval', approvalId, tool: toolName, input })

      const decision = await new Promise<{ allow: boolean; note: string | null }>((resolve) => {
        const timer = setTimeout(() => {
          awaiting.delete(approvalId)
          // Say so, or the card on the other side sits at "waiting" forever describing a
          // decision that has already been made for it.
          emit(sessionId, { kind: 'approval_expired', approvalId })
          resolve({ allow: false, note: 'no answer' })
        }, approvalTimeoutMs)
        awaiting.set(approvalId, { resolve, timer })
      })

      return decision.allow
        ? ({ behavior: 'allow', updatedInput: input } as const)
        : ({
            behavior: 'deny',
            message: decision.note
              ? `The human declined this: ${decision.note}`
              : 'The human declined this. Do not retry it; ask what they would prefer instead.',
          } as const)
    }
  }

  async function run(sessionId: string, prompt: string, unattended: boolean, projectId?: string): Promise<void> {
    // A user-global runtime (@spec) picks the project per turn; a pinned one (@coder) has no projectId
    // forwarded — or it equals its own — so the fixed mcpUrl stands.
    const mcpUrl = projectId && opts.mcpUrlFor ? opts.mcpUrlFor(projectId) : opts.mcpUrl

    let who: Profile
    try {
      who = await profile(mcpUrl)
    } catch (cause) {
      // Worth failing loudly rather than running blind: an agent that silently lost the
      // glossary will implement something plausible and wrong.
      emit(sessionId, {
        kind: 'error',
        text: `Cannot reach the spec tool at ${mcpUrl} (${(cause as Error).message}). Not starting a run without it.`,
      })
      return
    }

    const consumeTurn = async (turnPrompt: string): Promise<{ subtype: string; stopReason: string | null }> => {
      const resume = sdkSessions.get(sessionId)
      // Default to a natural end, so a turn with no result message (nothing to continue) just stops.
      let subtype = 'success'
      let stopReason: string | null = null
      for await (const message of query({
        prompt: turnPrompt,
        options: {
          // Over HTTP to the spec tool, not in-process. One definition of these tools exists
          // and it lives with the files they touch. The auth header (when set) rides every tool
          // call so a hosted coordinator can attribute the write to the user who ran the turn.
          mcpServers: { blueprints: { type: 'http', url: mcpUrl, ...(opts.authToken ? { headers: authHeaders } : {}) } },
          tools: who.builtins,
          // Reads run freely; anything that changes a file or runs a command is not here,
          // which is what routes it through canUseTool and out to the approval card.
          allowedTools: [
            ...who.tools.map((name) => `mcp__blueprints__${name}`),
            ...who.autoApprove,
          ],
          ...(who.disallowedTools.length > 0 ? { disallowedTools: who.disallowedTools } : {}),
          canUseTool: askPermission(sessionId, unattended),
          settingSources: [],
          systemPrompt: who.systemPrompt,
          includePartialMessages: true,
          cwd: opts.appDir,
          ...(resume ? { resume } : {}),
        },
      })) {
        if (message.type === 'system' && 'session_id' in message && message.session_id) {
          sdkSessions.set(sessionId, message.session_id as string)
        } else if (message.type === 'stream_event') {
          const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            emit(sessionId, { kind: 'delta', text: event.delta.text ?? '' })
          }
        } else if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              emit(sessionId, { kind: 'assistant', text: block.text })
            }
            if (block.type === 'tool_use') {
              emit(sessionId, { kind: 'tool_call', tool: block.name, id: block.id, input: block.input })
            }
          }
        } else if (message.type === 'user') {
          // Tool results arrive as a user turn. Relayed on so the transcript on the other
          // side can settle the call — without this a tool row streams as "running" and stays
          // there, because nothing else ever mentions that id again.
          const content = message.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
                const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
                emit(sessionId, {
                  kind: 'tool_result',
                  id: result.tool_use_id,
                  isError: result.is_error === true,
                  content: result.content ?? null,
                })
              }
            }
          }
        } else if (message.type === 'result') {
          if (message.session_id) sdkSessions.set(sessionId, message.session_id)
          subtype = message.subtype
          if (message.subtype === 'success') {
            // stop_reason rides the result message, not the streamed frames — 'max_tokens' is a cutoff.
            stopReason = (message as { stop_reason?: string | null }).stop_reason ?? null
          } else {
            emit(sessionId, { kind: 'error', text: `The run ended early (${message.subtype}).` })
          }
        }
      }
      return { subtype, stopReason }
    }

    try {
      let turnPrompt = prompt
      let continuationsUsed = 0
      // GH #156: a turn cut off at the output limit is not finished — continue it, bounded, by resuming
      // the session (never restarting: that would replay the prompt and re-fire any writes already made).
      while (true) {
        const { subtype, stopReason } = await consumeTurn(turnPrompt)
        const decision = afterTokenResult(subtype, stopReason, continuationsUsed)
        if (decision === 'exhausted') {
          emit(sessionId, {
            kind: 'error',
            text: `The reply was cut off at the output limit and could not finish after ${continuationsUsed} automatic continuation${continuationsUsed === 1 ? '' : 's'}. Ask it to continue, or split the work.`,
          })
        }
        if (decision !== 'continue') break
        continuationsUsed += 1
        turnPrompt = CONTINUATION_PROMPT
      }
    } catch (cause) {
      emit(sessionId, { kind: 'error', text: (cause as Error).message })
    }
  }

  return {
    // The health-check profile uses the fixed endpoint; per-turn projects are resolved inside run().
    profile: () => profile(opts.mcpUrl),

    subscribe(sessionId, onEvent) {
      const emitter = channel(sessionId)
      const handler = (event: unknown) => onEvent(event)
      emitter.on('event', handler)
      return () => emitter.off('event', handler)
    },

    submitDecision(approvalId, decision, note) {
      const pending = awaiting.get(approvalId)
      if (!pending) return { ok: false, error: 'Nothing is waiting on that any more.' }

      clearTimeout(pending.timer)
      awaiting.delete(approvalId)
      pending.resolve({
        allow: decision === 'allow',
        note: typeof note === 'string' && note.trim() ? note.trim() : null,
      })
      return { ok: true }
    },

    submitTurn(sessionId, prompt, unattended, projectId) {
      // Decided by the coordinator, per turn — never remembered here. A runtime that kept its own
      // "permissions off" state would be a runtime that could keep it on.
      if (active.has(sessionId)) {
        return { ok: false, error: `@${opts.agent} is still working on the previous message.` }
      }

      active.add(sessionId)
      void run(sessionId, prompt, unattended, projectId).finally(() => {
        active.delete(sessionId)
        emit(sessionId, { kind: 'done' })
      })
      return { ok: true }
    },
  }
}
