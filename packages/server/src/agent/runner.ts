/**
 * Runs the spec agent and records what it does.
 *
 * The run is deliberately not tied to the HTTP request that started it. A turn can take
 * minutes; closing the tab must not kill it. So `send()` returns as soon as the run is
 * launched, every durable event lands in SQLite, and the SSE endpoint reads from there.
 * Reconnecting is then just "replay from cursor" rather than anything stateful.
 *
 * Two stores, on purpose. SQLite is the product record — searchable, prunable, and what
 * the UI replays. The SDK keeps its own session for resuming a conversation; we hold on
 * to its id and nothing more.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptStore } from '@abseed/spectra-core'
import type { SpecStoreBackend } from '../backend.js'
import type { AgentProvider } from './agentProvider.js'
import { CODER_URL, SPEC_URL, probe } from '../sandbox.js'
import type { AgentDefinition, AgentName } from './agents.js'
import { qualified, toolsFor } from './tools.js'
import { isRaiseTool, specProactiveEnabled, triageNotice, triagePrompt } from './escalation.js'
import { CONTINUATION_PROMPT, afterResult, truncationExhaustedNotice } from './truncation.js'

/** How long a pending approval waits before giving up, so a run cannot hang forever. */
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

interface PendingApproval {
  resolve: (decision: { allow: boolean; note: string | null }) => void
  timer: NodeJS.Timeout
}

export interface RunnerEvent {
  /** `update` re-sends a row that already streamed — a tool call that has now settled. */
  kind: 'append' | 'update' | 'delta' | 'done' | 'approval'
  /** Durable events carry their transcript id; deltas do not. */
  id?: number
  toolCallId?: string
  approvalId?: string
  text?: string
}

export class AgentRunner {
  private readonly emitters = new Map<string, EventEmitter>()
  /**
   * SDK session id per channel *and* agent — each keeps its own conversation, so asking
   * @coder something does not land in the middle of @spec's thread.
   */
  private readonly sdkSessions = new Map<string, string>()
  /** Keyed the same way: @spec working does not block you from messaging @coder. */
  private readonly active = new Set<string>()
  /** Tool calls waiting on a human decision, keyed by the approval id shown in the card. */
  private readonly awaiting = new Map<string, PendingApproval>()
  /**
   * Approvals owned by the sandbox rather than by a promise in this process. The card looks
   * identical from the UI; the difference is where the decision has to be delivered.
   */
  private readonly remoteApprovals = new Map<string, { sessionId: string; url: string }>()
  /**
   * Sessions where the human has said not to ask, by session id.
   *
   * Deliberately in memory. A permission relaxation that survives a restart is one nobody
   * remembers granting, and the cost of losing it is a single click.
   */
  private readonly unattended = new Set<string>()

  constructor(
    /** Resolves the store for a project; a turn uses the store for its session's project. */
    private readonly provider: SpecStoreBackend,
    /** Resolves that project's agents — the system prompt named for the glossary it works on. */
    private readonly agentProvider: AgentProvider,
    private readonly transcripts: TranscriptStore,
  ) {}

  /**
   * Two ways to authenticate, and they are not interchangeable. A console API key
   * (`sk-ant-api...`) goes in ANTHROPIC_API_KEY; a Claude subscription token from
   * `claude setup-token` (`sk-ant-oat...`) goes in CLAUDE_CODE_OAUTH_TOKEN. Putting an
   * OAuth token in the API-key variable loads cleanly and then fails at the first call
   * with "Invalid API key", which is a confusing way to find out.
   *
   * `||` and not `??`: docker compose's `${VAR:-}` sets the variable to an empty string
   * rather than leaving it absent, and `??` treats "" as a present value — so the API-key
   * slot being empty would mask a perfectly good OAuth token sitting next to it.
   */
  static get configured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
  }

  /** Null when the credential looks like it is in the wrong variable. */
  static get misconfiguration(): string | null {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (apiKey?.startsWith('sk-ant-oat')) {
      return 'ANTHROPIC_API_KEY holds a Claude Code OAuth token (sk-ant-oat…). Move it to CLAUDE_CODE_OAUTH_TOKEN, or use a console API key (sk-ant-api…) instead.'
    }
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (oauth?.startsWith('sk-ant-api')) {
      return 'CLAUDE_CODE_OAUTH_TOKEN holds a console API key (sk-ant-api…). Move it to ANTHROPIC_API_KEY.'
    }
    return null
  }

  isRunning(sessionId: string): boolean {
    return [...this.active].some((key) => key.startsWith(`${sessionId}:`))
  }

  events(sessionId: string): EventEmitter {
    let emitter = this.emitters.get(sessionId)
    if (!emitter) {
      emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      this.emitters.set(sessionId, emitter)
    }
    return emitter
  }

  private async record(sessionId: string, event: Parameters<TranscriptStore['append']>[1]): Promise<number> {
    const id = await this.transcripts.append(sessionId, event, new Date().toISOString())
    this.events(sessionId).emit('event', { kind: 'append', id } satisfies RunnerEvent)
    return id
  }

  /**
   * Records the human turn, then launches the agent. Resolves once the run has started —
   * output arrives over the session's event stream, not by awaiting this.
   */
  async send(sessionId: string, prompt: string, to: AgentName | null): Promise<{ ok: boolean; error?: string }> {
    await this.record(sessionId, { author: 'human', kind: 'user', text: prompt })

    // Unaddressed messages go to nobody, as in any channel. Two agents racing to answer
    // is worse than a message that visibly waits for you to say who it is for.
    if (!to) return { ok: true }

    return this.launch(sessionId, prompt, to)
  }

  /**
   * Records a line as if spoken by an agent — not the human — and streams it. Lets @coder announce
   * something it is doing (the auto-implementation countdown and lead-in) around a turn the human
   * did not type, without faking a human message to carry the explanation.
   */
  async notify(sessionId: string, author: AgentName, text: string): Promise<void> {
    await this.record(sessionId, { author, kind: 'assistant', text })
  }

  /**
   * Starts @coder on its own, triggered by a spec change rather than a typed message. Nobody typed
   * this turn, so — unlike {@link send} — there is no human message to record: it launches straight
   * into the run. The transcript's "why" comes from the {@link notify} lines posted around it.
   */
  async autoImplement(sessionId: string, prompt: string): Promise<{ ok: boolean; error?: string }> {
    return this.launch(sessionId, prompt, 'coder')
  }

  /**
   * Launches a turn: the guard against a double-run, the credential checks, and the relay-or-in-process
   * dispatch. Shared by {@link send} (after it records the human turn) and {@link autoImplement} (which
   * has no human turn to record).
   */
  private async launch(sessionId: string, prompt: string, to: AgentName): Promise<{ ok: boolean; error?: string }> {
    const key = `${sessionId}:${to}`
    if (this.active.has(key)) {
      return { ok: false, error: `@${to} is still working on the previous message.` }
    }

    const misconfigured = AgentRunner.misconfiguration
    if (misconfigured) {
      await this.record(sessionId, { author: to, kind: 'error', text: misconfigured })
      return { ok: true }
    }

    if (!AgentRunner.configured) {
      await this.record(sessionId, {
        author: to,
        kind: 'error',
        text: 'No credential is set, so the agent cannot run. Put a console API key in ANTHROPIC_API_KEY, or a `claude setup-token` token in CLAUDE_CODE_OAUTH_TOKEN, then restart the server.',
      })
      return { ok: true }
    }

    this.active.add(key)
    // An agent with a configured runtime URL is relayed to it; otherwise it runs in-process. Both
    // agents work the same way — @coder has always had CODER_URL, @spec now has SPEC_URL — so which
    // side a turn runs on is a deployment choice, not a property baked into the agent.
    const url = this.urlFor(to)
    const start = url ? this.relay(sessionId, prompt, to, url) : this.run(sessionId, prompt, to)
    void start.finally(() => {
      this.active.delete(key)
      this.events(sessionId).emit('event', { kind: 'done' } satisfies RunnerEvent)
      // GH #137: a @coder run that raised questions/expectations/scenarios wakes @spec to triage them.
      // After the run ends (active cleared) so @spec's turn isn't blocked by @coder still holding a slot.
      if (to === 'coder') void this.maybeEscalateToSpec(sessionId)
    })

    return { ok: true }
  }

  /**
   * The raise tools @coder emitted in its current run, per session — collected during the run and
   * drained when it ends to wake @spec once (GH #137). Counting on *emit* (not result) matches "any
   * raise @coder makes": the free-adds rarely fail, and waking @spec to look at nothing is harmless.
   */
  private readonly raisedByCoder = new Map<string, string[]>()

  private noteCoderRaise(sessionId: string, shortName: string): void {
    if (!isRaiseTool(shortName)) return
    const list = this.raisedByCoder.get(sessionId) ?? []
    list.push(shortName)
    this.raisedByCoder.set(sessionId, list)
  }

  /**
   * Wake @spec to triage what @coder just raised. Opt-in (SPEC_PROACTIVE), skipped when nothing was
   * raised or @spec is already working this session. @spec triages within its normal repertoire —
   * propose a changeset, or sharpen a question — never deciding a product fork. No human message: the
   * transcript's "why" is the notice, attributed to @spec.
   */
  private async maybeEscalateToSpec(sessionId: string): Promise<void> {
    const raised = this.raisedByCoder.get(sessionId)
    this.raisedByCoder.delete(sessionId)
    if (!specProactiveEnabled() || !raised || raised.length === 0) return
    if (this.active.has(`${sessionId}:spec`)) return // @spec busy — skip this batch (a later raise re-wakes it)
    await this.notify(sessionId, 'spec', triageNotice(raised))
    await this.launch(sessionId, triagePrompt(raised), 'spec')
  }

  /** The runtime URL for an agent, or null to run it in-process. The one place the mapping lives. */
  private urlFor(to: AgentName): string | null {
    return to === 'coder' ? CODER_URL : to === 'spec' ? SPEC_URL : null
  }

  private async run(sessionId: string, prompt: string, to: AgentName): Promise<void> {
    // A turn acts on its session's project: the store it writes to and the agents whose prompt
    // names the glossary both come from that projectId, not a process-wide default. The session
    // carries it (slice 5); the route validated it exists before this launched.
    const session = await this.transcripts.getSession(sessionId)
    if (!session) {
      await this.record(sessionId, { author: to, kind: 'error', text: `Conversation ${sessionId} is gone.` })
      return
    }
    const store = this.provider.storeFor(session.projectId)
    const agent = (await this.agentProvider.agentsFor(session.projectId))[to]
    const server = createSdkMcpServer({
      name: 'blueprints',
      version: '1.0.0',
      // The agent's own identity, stamped on anything it writes — `to` is 'spec' or 'coder'.
      // ToolDef is the SDK's SdkMcpToolDefinition minus the optional `_meta`; the cast bridges the
      // two structurally identical shapes (the tools carry no _meta).
      tools: toolsFor(store, this.transcripts, { kind: to }, agent.domainTools) as Parameters<typeof createSdkMcpServer>[0]['tools'],
    })

    const key = `${sessionId}:${to}`
    /** Tool calls seen this turn, so a result can be matched back to its call. Spans continuations. */
    const openCalls = new Map<string, string>()

    try {
      let turnPrompt = prompt
      let continuationsUsed = 0
      // GH #156: a turn that stops at its output limit (max_tokens) is not finished — continue it,
      // bounded, by resuming the SDK session inside consumeTurn (never restarting: a restart would
      // replay the prompt and re-fire the unguarded raise_* writes the truncated turn already made).
      while (true) {
        const { subtype, stopReason } = await this.consumeTurn(sessionId, to, key, turnPrompt, openCalls, server, agent)
        const decision = afterResult({ subtype, stopReason, continuationsUsed })
        if (decision === 'exhausted') {
          await this.record(sessionId, { author: to, kind: 'error', text: truncationExhaustedNotice(continuationsUsed) })
        }
        if (decision !== 'continue') break
        continuationsUsed += 1
        turnPrompt = CONTINUATION_PROMPT
      }
    } catch (cause) {
      await this.record(sessionId, { author: to, kind: 'error', text: (cause as Error).message })
    } finally {
      // Anything still open died with the run. Leaving it marked `started` is the honest
      // record — a later resume can see the call may or may not have taken effect. Runs once, after
      // the last continuation, so a call opened in one pass and settled in the next is not lost.
      for (const [callId] of openCalls) {
        await this.transcripts.settleToolCall(callId, 'failed', { error: 'the run ended before this returned' })
      }
    }
  }

  /**
   * Consume one query() turn — the SDK message loop, resumed from this channel's session — and report
   * the result's subtype and stop_reason so {@link run} can decide whether the turn truncated at the
   * output limit and should continue (GH #156). Everything it records (assistant text, tool calls and
   * results, an early-end error) is exactly as it was when this loop lived inline in `run`; only the
   * bounded continuation loop around it, and this return value, are new.
   */
  private async consumeTurn(
    sessionId: string,
    to: AgentName,
    key: string,
    prompt: string,
    openCalls: Map<string, string>,
    server: ReturnType<typeof createSdkMcpServer>,
    agent: AgentDefinition,
  ): Promise<{ subtype: string; stopReason: string | null }> {
    const resume = this.sdkSessions.get(key)
    // Default to a natural end, so a turn that yields no result message (nothing to continue) simply stops.
    let subtype = 'success'
    let stopReason: string | null = null
    for await (const message of query({
      prompt,
      options: {
        mcpServers: { blueprints: server },
        // @spec gets none of these, so it reaches the repo only through domain tools.
        // @coder gets file access, rooted at app/ by cwd below.
        tools: agent.builtins,
        // Only the auto-approved builtins go here. A tool named bare in allowedTools
        // never reaches canUseTool, so listing Edit would silently skip its card.
        allowedTools: [...qualified(agent.domainTools), ...agent.autoApprove],
        canUseTool: this.askPermission(sessionId, to),
        ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
        // Do not inherit the machine's Claude Code settings. Without this the spec agent
        // picks up whatever MCP servers the user has configured globally — Gmail, Drive,
        // Calendar — which have no business being reachable from a glossary tool.
        settingSources: [],
        systemPrompt: agent.systemPrompt,
        includePartialMessages: true,
        cwd: agent.cwd,
        ...(resume ? { resume } : {}),
      },
    })) {
      if (message.type === 'system' && 'session_id' in message && message.session_id) {
        this.sdkSessions.set(key, message.session_id as string)
        continue
      }

      if (message.type === 'stream_event') {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          // Deltas are for live typing only — never persisted, so a reconnect mid-answer
          // simply waits for the complete message rather than stitching fragments.
          this.events(sessionId).emit('event', {
            kind: 'delta',
            text: event.delta.text ?? '',
          } satisfies RunnerEvent)
        }
        continue
      }

      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            await this.record(sessionId, { author: to, kind: 'assistant', text: block.text })
          }
          if (block.type === 'tool_use') {
            openCalls.set(block.id, block.name)
            if (to === 'coder') this.noteCoderRaise(sessionId, shortName(block.name))
            await this.record(sessionId, {
              author: to,
              kind: 'tool_call',
              text: shortName(block.name),
              payload: { input: block.input },
              toolCallId: block.id,
              status: 'started',
            })
          }
        }
        continue
      }

      if (message.type === 'user') {
        // Tool results come back as a user turn; settle the call they belong to.
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
              const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
              if (!openCalls.has(result.tool_use_id)) continue
              await this.transcripts.settleToolCall(
                result.tool_use_id,
                result.is_error ? 'failed' : 'completed',
                result.content ?? null,
              )
              openCalls.delete(result.tool_use_id)
              this.events(sessionId).emit('event', {
                kind: 'update',
                toolCallId: result.tool_use_id,
              } satisfies RunnerEvent)
            }
          }
        }
        continue
      }

      if (message.type === 'result') {
        if (message.session_id) this.sdkSessions.set(key, message.session_id)
        subtype = message.subtype
        if (message.subtype === 'success') {
          // stop_reason rides the result message, not the streamed assistant frames (those are null
          // under includePartialMessages). 'max_tokens' here is a cutoff, not a finish — see run().
          stopReason = (message as { stop_reason?: string | null }).stop_reason ?? null
        } else {
          await this.record(sessionId, {
            author: to,
            kind: 'error',
            text: `The run ended early (${message.subtype}).`,
          })
        }
      }
    }
    return { subtype, stopReason }
  }

  /**
   * The same turn, run in `to`'s out-of-process runtime instead of here — @coder's sandbox, or
   * @spec's own runtime once one is configured. The runtime holds no history on purpose, so this
   * is not a handoff, it is a relay: every event it streams is written to the same transcript rows
   * the in-process path writes, which is why the UI needs no idea which side ran the turn.
   *
   * There is no fallback. If a runtime is configured (a URL is set) and unreachable, the turn does
   * not run. For @coder that is a boundary: quietly running unsandboxed under a UI that says
   * "sandboxed" would be worse than not running. For @spec it is just honesty — you asked for a
   * runtime, so a down one is an error, not a silent fall back into this process. An *unset* URL is
   * the different, deliberate choice to run in-process, which `send` routes to `run`.
   */
  private async relay(sessionId: string, prompt: string, to: AgentName, url: string): Promise<void> {
    const openCalls = new Set<string>()
    const controller = new AbortController()

    const reach = await probe(url)
    if (!reach.reachable) {
      await this.record(sessionId, {
        author: to,
        kind: 'error',
        text: `@${to}'s runtime at ${url} is not reachable${reach.error ? ` (${reach.error})` : ''}. Nothing ran — start it, or unset its URL to run in-process. There is deliberately no silent fallback.`,
      })
      return
    }

    try {
      // Open the stream before sending the turn. The runtime's emitter does not buffer,
      // so anything it publishes before this listener attaches is simply gone — and the
      // first tool call arrives fast enough for that to be a real race, not a theoretical.
      const stream = await fetch(`${url}/sessions/${sessionId}/stream`, {
        signal: controller.signal,
      })
      if (!stream.ok || !stream.body) {
        throw new Error(`The runtime would not open a stream (${stream.status}).`)
      }

      const turn = await fetch(`${url}/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent per turn rather than set on the container, so the sandbox never holds its own
        // idea of whether it may skip approvals.
        body: JSON.stringify({ prompt, unattended: this.unattended.has(sessionId) }),
      })
      if (!turn.ok) {
        throw new Error(`The runtime refused the turn (${turn.status}): ${await turn.text()}`)
      }

      for await (const event of readEvents(stream.body)) {
        if (event.kind === 'done') break

        if (event.kind === 'delta') {
          this.events(sessionId).emit('event', {
            kind: 'delta',
            text: String(event.text ?? ''),
          } satisfies RunnerEvent)
        } else if (event.kind === 'assistant') {
          await this.record(sessionId, { author: to, kind: 'assistant', text: String(event.text ?? '') })
        } else if (event.kind === 'tool_call') {
          const id = String(event.id)
          openCalls.add(id)
          if (to === 'coder') this.noteCoderRaise(sessionId, shortName(String(event.tool)))
          await this.record(sessionId, {
            author: to,
            kind: 'tool_call',
            text: shortName(String(event.tool)),
            payload: { input: event.input },
            toolCallId: id,
            status: 'started',
          })
        } else if (event.kind === 'tool_result') {
          const id = String(event.id)
          if (!openCalls.delete(id)) continue
          await this.transcripts.settleToolCall(id, event.isError ? 'failed' : 'completed', event.content ?? null)
          this.events(sessionId).emit('event', { kind: 'update', toolCallId: id } satisfies RunnerEvent)
        } else if (event.kind === 'approval') {
          const approvalId = String(event.approvalId)
          // Recorded here, decided here, delivered back over HTTP by `decide` — to this runtime's
          // url, so a decision always returns to the runtime that is actually blocked on it.
          this.remoteApprovals.set(approvalId, { sessionId, url })
          await this.record(sessionId, {
            author: to,
            kind: 'approval',
            text: String(event.tool),
            payload: { input: event.input },
            toolCallId: approvalId,
            status: 'started',
          })
        } else if (event.kind === 'auto_approved') {
          // Recorded exactly like one you answered, settled in the same breath. Not asking
          // is not the same as not saying: the transcript still shows every write and every
          // command, so an unattended run is reviewable after the fact rather than invisible.
          const approvalId = String(event.approvalId)
          await this.record(sessionId, {
            author: to,
            kind: 'approval',
            text: String(event.tool),
            payload: { input: event.input },
            toolCallId: approvalId,
            status: 'started',
          })
          await this.transcripts.settleApproval(approvalId, 'allow', 'unattended')
          this.events(sessionId).emit('event', { kind: 'approval', approvalId } satisfies RunnerEvent)
        } else if (event.kind === 'approval_expired') {
          const approvalId = String(event.approvalId)
          this.remoteApprovals.delete(approvalId)
          await this.transcripts.settleApproval(approvalId, 'deny', 'no answer')
          this.events(sessionId).emit('event', { kind: 'approval', approvalId } satisfies RunnerEvent)
        } else if (event.kind === 'error') {
          await this.record(sessionId, { author: to, kind: 'error', text: String(event.text ?? '') })
        }
      }
    } catch (cause) {
      await this.record(sessionId, { author: to, kind: 'error', text: (cause as Error).message })
    } finally {
      controller.abort()
      // Same honesty as the in-process path: a call still open died with the run, and may
      // or may not have taken effect on the far side.
      for (const callId of openCalls) {
        await this.transcripts.settleToolCall(callId, 'failed', { error: 'the run ended before this returned' })
      }
    }
  }

  isUnattended(sessionId: string): boolean {
    return this.unattended.has(sessionId)
  }

  /**
   * Lets @coder work without a card for this session — and only where that is defensible.
   *
   * Refused outright when there is no reachable sandbox, rather than warned about. Running
   * in-process means the agent has a shell on your actual filesystem and the card is the
   * only boundary there is; "skip the only boundary" is not a preference to be respected.
   * The permission is a property of running in a box, so no box means no permission.
   *
   * Turning it *off* never needs a sandbox — you can always ask to be asked again.
   */
  async setUnattended(sessionId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!enabled) {
      this.unattended.delete(sessionId)
      return { ok: true }
    }

    if (!CODER_URL) {
      return {
        ok: false,
        error: 'No sandbox is configured, so @coder runs in this process with a shell on your filesystem. The approval card is the only boundary there — it cannot be turned off.',
      }
    }

    const reach = await probe(CODER_URL)
    if (!reach.reachable) {
      return {
        ok: false,
        error: `The sandbox is not reachable${reach.error ? ` (${reach.error})` : ''}, so nothing can run unattended. Start it with \`docker compose up -d\`.`,
      }
    }

    this.unattended.add(sessionId)
    return { ok: true }
  }

  newSessionId(): string {
    return randomUUID()
  }

  /**
   * Answers a pending approval. Returns false when nothing is waiting — the run was
   * abandoned, or the server restarted and the promise went with it. The transcript row
   * still says `started` in that case, which is the honest record.
   */
  async decide(approvalId: string, allow: boolean, note: string | null): Promise<boolean> {
    const pending = this.awaiting.get(approvalId)
    if (pending) {
      clearTimeout(pending.timer)
      this.awaiting.delete(approvalId)
      await this.transcripts.settleApproval(approvalId, allow ? 'allow' : 'deny', note)
      this.events(await this.sessionOf(approvalId)).emit('event', {
        kind: 'approval',
        approvalId,
      } satisfies RunnerEvent)
      pending.resolve({ allow, note })
      return true
    }

    // Not ours: a run blocked inside a relayed runtime, waiting on this decision over HTTP.
    const remote = this.remoteApprovals.get(approvalId)
    if (remote === undefined) return false

    // Deliver first, record second. Settling the transcript for a decision that never
    // arrived would leave the row saying "allowed" beside an agent still sitting on the
    // question — the one inconsistency worth ordering the code around.
    const response = await fetch(`${remote.url}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: allow ? 'allow' : 'deny', note }),
    }).catch(() => null)

    if (!response?.ok) return false

    this.remoteApprovals.delete(approvalId)
    await this.transcripts.settleApproval(approvalId, allow ? 'allow' : 'deny', note)
    this.events(remote.sessionId).emit('event', { kind: 'approval', approvalId } satisfies RunnerEvent)
    return true
  }

  private async sessionOf(approvalId: string): Promise<string> {
    return (await this.transcripts.readApproval(approvalId))?.sessionId ?? ''
  }

  /**
   * The SDK calls this before any tool that is not auto-approved. It records the request,
   * pushes it to the UI, and blocks — the run genuinely waits here, which is the point.
   */
  private askPermission(sessionId: string, to: AgentName) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string }
    > => {
      const approvalId = randomUUID()
      await this.record(sessionId, {
        author: to,
        kind: 'approval',
        text: toolName,
        payload: { input },
        toolCallId: approvalId,
        status: 'started',
      })

      const decision = await new Promise<{ allow: boolean; note: string | null }>((resolve) => {
        const timer = setTimeout(() => {
          this.awaiting.delete(approvalId)
          // Fire-and-forget: the deny is recorded for the transcript, but the run is unblocked by
          // `resolve` regardless of when the write lands. A failed settle is a lost annotation, not
          // a hung run.
          void this.transcripts.settleApproval(approvalId, 'deny', 'no answer')
          resolve({ allow: false, note: 'no answer' })
        }, APPROVAL_TIMEOUT_MS)

        this.awaiting.set(approvalId, { resolve, timer })
      })

      return decision.allow
        ? { behavior: 'allow', updatedInput: input }
        : {
            behavior: 'deny',
            message: decision.note
              ? `The human declined this: ${decision.note}`
              : 'The human declined this. Do not retry it; ask what they would prefer instead.',
          }
    }
  }
}

function shortName(toolName: string): string {
  return toolName.replace(/^mcp__blueprints__/, '')
}

/**
 * The sandbox's SSE stream, as events.
 *
 * Deliberately minimal: this consumes one stream from one service we wrote, which only ever
 * sends `data:` lines and keep-alive comments. A full SSE parser would handle event types,
 * ids and retry hints that nothing here emits.
 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) return

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    // The last piece may be half a line; keep it for the next chunk.
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        yield JSON.parse(line.slice(6)) as Record<string, unknown>
      } catch {
        // A malformed frame is the sandbox's bug, not a reason to drop the whole run.
      }
    }
  }
}
