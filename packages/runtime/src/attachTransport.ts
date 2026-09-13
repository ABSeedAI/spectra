/**
 * The runtime as an outbound client that *dials a coordinator* — the mirror image of
 * {@link ./httpTransport.ts}.
 *
 * The HTTP transport works because the coordinator can reach the runtime: it sits on the same
 * network and dials in. When the runtime runs on a machine the coordinator *cannot* reach — behind
 * NAT, no inbound port, no public address — that inverts: the runtime must dial out. And a single
 * connection the runtime opened still has to carry the coordinator's pushes back down it (turns,
 * approval decisions), which request/response HTTP cannot do. So this is one bidirectional
 * WebSocket, carrying the same three verbs the HTTP routes carried, multiplexed by `sessionId`.
 *
 * It is deliberately coordinator-agnostic: it is handed a URL and a device token and speaks the
 * frames below to whatever answers. It knows nothing about who runs the coordinator or where.
 *
 * ── Wire frames (one JSON object per WebSocket text message: `{ t, sessionId?, ... }`) ───────────
 *
 * Runtime → coordinator (this side sends):
 *   hello              { runtime, version, token }        first frame; authenticates the socket
 *   delta              { sessionId, text }                live typing, ephemeral (never persisted)
 *   assistant          { sessionId, text }                a completed assistant message
 *   tool_call          { sessionId, id, tool, input }     a tool invocation began
 *   tool_result        { sessionId, id, isError, content }a tool invocation settled
 *   approval           { sessionId, approvalId, tool, input }  a run is blocked awaiting a decision
 *   auto_approved      { sessionId, approvalId, tool, input }  allowed without asking (unattended)
 *   approval_expired   { sessionId, approvalId }          nobody answered in time; treated as deny
 *   error              { sessionId, text }                a run-level failure (incl. a busy turn)
 *   done               { sessionId }                      the turn finished
 *   pong               { }                                reply to a ping
 *
 * Coordinator → runtime (this side receives):
 *   turn               { sessionId, projectId?, prompt, unattended? } start a turn (projectId scopes a user-global @spec)
 *   decision           { approvalId, decision, note? }    deliver a human's approval decision
 *   ping               { }                                keepalive
 *
 * Every upstream event but `hello`/`pong` is exactly what the engine emits, re-tagged `t = kind`
 * and stamped with the `sessionId` it belongs to — the identical vocabulary the HTTP stream sends,
 * so a coordinator records a relayed turn the same way whichever transport carried it.
 *
 * Reconnect: on a drop the socket is re-dialed with capped backoff. Subscriptions to the engine's
 * per-session emitters are kept across reconnects, so a turn in flight resumes streaming to the new
 * socket; only events emitted during the actual gap are lost (the emitter does not buffer — the same
 * property the HTTP SSE stream already has). Durable rows are the coordinator's to replay from its
 * own store, not this runtime's to re-send.
 */
import type { Engine } from './engine.js'

export interface AttachOptions {
  /** Which agent this runtime is — announced in `hello` so the coordinator routes turns to it. */
  agent: string
  /**
   * The project this runtime serves — announced in `hello` so a coordinator can route per project
   * (one runtime per project). Omit to be user-global (the coordinator matches it to any project).
   */
  projectId?: string
  /** The coordinator's attach endpoint, `ws://` or `wss://`. */
  url: string
  /** Device token identifying this machine's user; sent in `hello` for the coordinator to verify. */
  token: string
  /** Reported in `hello`; purely informational. */
  version?: string
  minBackoffMs?: number
  maxBackoffMs?: number
}

export interface Attachment {
  /** Stops reconnecting and closes the socket. */
  close(): void
}

export function serveAttach(engine: Engine, opts: AttachOptions): Attachment {
  const minBackoff = opts.minBackoffMs ?? 500
  const maxBackoff = opts.maxBackoffMs ?? 15_000

  let socket: WebSocket | null = null
  let closed = false
  let backoff = minBackoff
  /** One engine subscription per session, kept for the process's life (across reconnects). */
  const subscriptions = new Map<string, () => void>()

  function send(frame: Record<string, unknown>): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  /**
   * Subscribe this session's engine events to the socket, once. The engine emits `{ kind, ...rest }`;
   * we forward it as `{ t: kind, sessionId, ...rest }`. Guarded so repeat turns on one session do not
   * stack subscriptions.
   */
  function ensureSubscribed(sessionId: string): void {
    if (subscriptions.has(sessionId)) return
    const unsubscribe = engine.subscribe(sessionId, (event) => {
      const { kind, ...rest } = event as { kind: string } & Record<string, unknown>
      send({ t: kind, sessionId, ...rest })
    })
    subscriptions.set(sessionId, unsubscribe)
  }

  function onMessage(data: unknown): void {
    let frame: { t?: string } & Record<string, unknown>
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      // A malformed frame is the coordinator's bug, not a reason to drop the connection.
      return
    }

    switch (frame.t) {
      case 'ping':
        send({ t: 'pong' })
        return
      case 'turn': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
        const prompt = typeof frame.prompt === 'string' ? frame.prompt.trim() : ''
        if (!sessionId || !prompt) return
        // The project this turn is for — set by a coordinator that routes a user-global @spec across
        // projects. Absent for a project-pinned runtime (@coder), which acts on its own project.
        const projectId = typeof frame.projectId === 'string' ? frame.projectId : undefined
        ensureSubscribed(sessionId)
        const result = engine.submitTurn(sessionId, prompt, frame.unattended === true, projectId)
        // No response channel as HTTP had; a rejected (busy) turn is surfaced as a session error,
        // which the coordinator records like any other.
        if (!result.ok) send({ t: 'error', sessionId, text: result.error })
        return
      }
      case 'decision':
        engine.submitDecision(
          typeof frame.approvalId === 'string' ? frame.approvalId : '',
          frame.decision === 'allow' ? 'allow' : 'deny',
          typeof frame.note === 'string' ? frame.note : null,
        )
        return
      default:
        // Unknown frame types are ignored so the coordinator can add ones this runtime predates.
        return
    }
  }

  function connect(): void {
    if (closed) return
    const ws = new WebSocket(opts.url)
    socket = ws

    ws.addEventListener('open', () => {
      backoff = minBackoff
      send({ t: 'hello', runtime: opts.agent, version: opts.version ?? '0.0.0', token: opts.token, project: opts.projectId })
      console.log(`[${opts.agent}] attached to ${opts.url}`)
    })

    ws.addEventListener('message', (event) => onMessage((event as MessageEvent).data))

    ws.addEventListener('close', () => {
      if (socket === ws) socket = null
      if (closed) return
      const delay = backoff
      backoff = Math.min(backoff * 2, maxBackoff)
      console.log(`[${opts.agent}] disconnected; reconnecting in ${delay}ms`)
      setTimeout(connect, delay)
    })

    // An error is followed by a close; let close handle the reconnect, just ensure the socket ends.
    ws.addEventListener('error', () => {
      try {
        ws.close()
      } catch {
        // already closing
      }
    })
  }

  connect()

  return {
    close() {
      closed = true
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
      if (socket) {
        try {
          socket.close()
        } catch {
          // already closing
        }
      }
    },
  }
}
