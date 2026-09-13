/**
 * An out-of-process agent runtime — the entry point.
 *
 * Runs one agent's loop as a standalone service. It is written once and serves *either* agent —
 * `AGENT` selects which (`coder` by default; `spec` for the spec runtime). It holds its own identity
 * nowhere: the loop ({@link ./engine.ts}) fetches its profile (prompt, builtins, tools) from the
 * Server's `/mcp/<agent>/profile` per run, so who it is comes from the one definition in the Server,
 * not a copy in here. `@coder` runs next to the code it edits inside a container that can write only
 * its `APP_DIR`; `@spec` has no filesystem tools at all and just needs a cwd to exist. Either way
 * this holds no transcript — the record belongs with the specs, and a box you can delete and rebuild
 * should not be where anything is kept.
 *
 * This file is now only wiring: read the environment, build the engine, and start a transport. The
 * loop lives in {@link ./engine.ts}; the two transports in {@link ./httpTransport.ts} and
 * {@link ./attachTransport.ts}. `MODE` picks which:
 *   - `serve` (default) — an HTTP service a coordinator on the same network dials into. Unchanged.
 *   - `attach` — dials *out* to a coordinator this runtime cannot be reached from (behind NAT),
 *     over one WebSocket. Needs `COORDINATOR_URL` and a `DEVICE_TOKEN`.
 */
import { createEngine } from './engine.js'
import { serveHttp } from './httpTransport.js'
import { serveAttach } from './attachTransport.js'

// Which agent this runtime is. `coder` by default (back-compat); `spec` for the spec runtime.
// It only picks which profile to fetch and which name to log — the behavior is the profile's.
const AGENT = process.env.AGENT ?? 'coder'
const PORT = Number(process.env.PORT ?? 5177)
// The project @coder implements into — its cwd and only writable mount. Configurable so the
// container can be pointed at whatever project it serves; `spectra init` mounts the repo here.
// The glossary is NOT under this path — it arrives as tool calls (see SERVER_URL below).
const APP_DIR = process.env.APP_DIR ?? '/work/project'

/**
 * Where the glossary lives — a URL now, not a mount.
 *
 * This service used to read `/work/specs` from a read-only bind mount through its own copy of the
 * reader. Two problems, and the second is the real one: the copy had drifted from the spec tool's,
 * and a mount can only ever offer *reading* — writes to the glossary (raising a question, marking a
 * changeset implemented) were impossible from here. Over a tool call they are two capabilities,
 * granted individually, executed by the process that owns `specs/` and can refuse.
 *
 * `SERVER_URL` points at the Server (the coordinator). `SPEC_URL` is the old name for it and is
 * still read as a fallback, so a compose file from before the spec→server rename keeps working.
 */
const SERVER_URL = process.env.SERVER_URL ?? process.env.SPEC_URL ?? 'http://server:5174'
// This container is bound to one project — the repo it implements into — so it carries that
// project in the URL it reaches the glossary through. The server's MCP surface is per project
// (/mcp/orgs/<org>/projects/<id>/coder), so its profile fetch and every tool call act on the
// project this container is for, never a server-wide default. Set by compose / `spectra init`;
// the example project is the dev default.
const ORG = process.env.ORG ?? 'local'
const PROJECT_ID = process.env.PROJECT_ID ?? 'todo'
const MCP_URL = `${SERVER_URL}/mcp/orgs/${ORG}/projects/${PROJECT_ID}/${AGENT}`

// serve (default): reached by a coordinator on the same network. attach: dials out to one it cannot
// be reached from. Kept a plain string so an unknown value fails loudly below rather than silently
// defaulting.
const MODE = process.env.MODE ?? 'serve'

// The same device token that authenticates the attach WebSocket also authenticates the runtime's
// glossary (MCP) calls, so a hosted coordinator resolves the user and stamps the write. Unset in the
// sandbox, where the Server trusts the network.
const engine = createEngine({ agent: AGENT, appDir: APP_DIR, mcpUrl: MCP_URL, authToken: process.env.DEVICE_TOKEN })

if (MODE === 'attach') {
  const url = process.env.COORDINATOR_URL
  if (!url) {
    console.error('[%s] MODE=attach needs COORDINATOR_URL (ws:// or wss://). Exiting.', AGENT)
    process.exit(1)
  }
  // Unset is an error, not an empty string: an unauthenticated attach would bind to nobody, so a
  // missing token should fail at the coordinator rather than silently connect as no one.
  const token = process.env.DEVICE_TOKEN ?? ''
  serveAttach(engine, { agent: AGENT, url, token, projectId: PROJECT_ID })
} else if (MODE === 'serve') {
  serveHttp(engine, { agent: AGENT, port: PORT, appDir: APP_DIR, glossaryUrl: MCP_URL })
} else {
  console.error('[%s] Unknown MODE=%s (expected "serve" or "attach"). Exiting.', AGENT, MODE)
  process.exit(1)
}
