/**
 * The CLI's whole grammar, as pure functions.
 *
 * `spectra` does not run the stack itself — it wraps `docker compose`, which is the actual
 * process supervisor. So the interesting logic here is a *translation*: a friendly command in,
 * the `docker compose` argv out. Keeping that translation pure (no spawning, no filesystem) is
 * what lets it be tested exhaustively without a docker daemon — the runner in cli.ts is the thin
 * part that actually shells out.
 *
 * Two command shapes, gcloud/SAL-flavoured:
 *   - per-component:  `spectra <component> <verb>`   (control one piece)
 *   - whole-stack:    `spectra up | down | build`    (the lifecycle across all pieces)
 *
 * Verbs are up/down (not start/stop) to match compose and the way the stack is actually spoken
 * about. There is no separate `install`: `up` builds a missing image on its own, and `build` is
 * here only to pre-build or rebuild on demand.
 */

export const COMPONENTS = ['server', 'coder', 'web', 'spec'] as const
export type Component = (typeof COMPONENTS)[number]

export const VERBS = ['up', 'down', 'restart', 'status', 'logs'] as const
export type Verb = (typeof VERBS)[number]

/**
 * The friendly component name the CLI presents, mapped to the compose service it drives. Names now
 * match one-to-one: `server` is the coordinator, `coder` and `spec` are the two agent runtimes,
 * `web` is the UI. (`server` used to map to a `spec` service — a leftover from before the product
 * rename; that service is now `server` and the old `spec` name belongs to the @spec runtime.)
 */
const SERVICE: Record<Component, string> = { server: 'server', coder: 'coder', web: 'web', spec: 'spec' }

/**
 * `web` is the one service behind a compose profile (so a plain `docker compose up` leaves it
 * out — see docker-compose.yml). Anything that touches it must enable the profile, so it carries
 * `--profile web`; the whole-stack commands enable it too, so `up`/`build` cover web.
 */
const PROFILE_ARGS = ['--profile', 'web']
function profileFor(component: Component): string[] {
  return component === 'web' ? PROFILE_ARGS : []
}

/** `-f a -f b …` — one selector per compose file, in order (later files override earlier). */
function fileFlags(composeFiles: string[]): string[] {
  return composeFiles.flatMap((file) => ['-f', file])
}

/**
 * The docker compose top-level flags every command shares, before the subcommand: the credential
 * env-file (when the CLI found one) and the compose-file selectors. `--env-file` points compose at
 * the shared `spectra.env` so `${ANTHROPIC_API_KEY}` etc. in the compose files resolve without the
 * user exporting anything — a real shell export still overrides it (compose prefers the environment).
 * Passed in rather than read here so this stays pure: cli.ts decides whether the file exists.
 */
function topLevelFlags(composeFiles: string[], envFile?: string): string[] {
  return [...(envFile ? ['--env-file', envFile] : []), ...fileFlags(composeFiles)]
}

/**
 * The `docker compose` argv for one component+verb — everything after `docker compose`, including
 * the `-f` selectors so the command does not depend on the current directory. `-f` and `--profile`
 * are top-level flags and precede the subcommand.
 */
export function composeArgv(component: Component, verb: Verb, composeFiles: string[], envFile?: string): string[] {
  const service = SERVICE[component]
  const subcommand: Record<Verb, string[]> = {
    up: ['up', '-d', service],
    // Per-component "down" is stop-and-remove that one service; `docker compose down` alone is
    // whole-project, which is what `spectra down` is for.
    down: ['rm', '-sf', service],
    restart: ['restart', service],
    status: ['ps', service],
    logs: ['logs', '-f', service],
  }
  return [...topLevelFlags(composeFiles, envFile), ...profileFor(component), ...subcommand[verb]]
}

/** Whole-stack up/down. `up` enables the web profile so the full stack really is up. */
export function composeStackArgv(action: 'up' | 'down', composeFiles: string[], envFile?: string): string[] {
  if (action === 'up') return [...topLevelFlags(composeFiles, envFile), ...PROFILE_ARGS, 'up', '-d']
  // `down` removes every container in the project regardless of profile, so it needs none.
  return [...topLevelFlags(composeFiles, envFile), 'down']
}

/**
 * `build` provisions images — `docker compose build`. With the distribution compose this builds
 * from the pinned git context; with no component it builds everything (web profile enabled), with
 * one just that service. `up` builds a missing image anyway; this is for pre-building or rebuilding.
 */
export function composeBuildArgv(component: Component | undefined, composeFiles: string[], envFile?: string): string[] {
  if (component === undefined) return [...topLevelFlags(composeFiles, envFile), ...PROFILE_ARGS, 'build']
  return [...topLevelFlags(composeFiles, envFile), ...profileFor(component), 'build', SERVICE[component]]
}

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; component: Component; verb: Verb; dryRun: boolean; composeFiles: string[] }
  | { kind: 'stack'; action: 'up' | 'down'; dryRun: boolean; composeFiles: string[] }
  | { kind: 'build'; component?: Component; dryRun: boolean; composeFiles: string[] }
  | { kind: 'error'; message: string }

function isComponent(value: string): value is Component {
  return (COMPONENTS as readonly string[]).includes(value)
}
function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value)
}

/**
 * Parse an argv tail (everything after the program name) into an intent. Unknown input yields an
 * `error` carrying a message rather than throwing — cli.ts decides how to present it. `--compose-file`
 * may repeat; the files layer in order (base first, override next).
 */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  const composeFiles: string[] = []
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '-v' || arg === '--version') return { kind: 'version' }
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--compose-file') {
      const file = argv[i + 1]
      if (!file) return { kind: 'error', message: '--compose-file needs a path.' }
      composeFiles.push(file)
      i += 1
    } else if (arg.startsWith('-')) {
      return { kind: 'error', message: `Unknown option "${arg}".` }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) return { kind: 'help' }
  const [head, second, ...rest] = positional

  // Whole-stack lifecycle.
  if (head === 'up' || head === 'down') {
    if (second !== undefined) return { kind: 'error', message: `Unexpected argument "${second}".` }
    return { kind: 'stack', action: head, dryRun, composeFiles }
  }
  if (head === 'build') {
    if (second !== undefined && second !== 'all' && !isComponent(second)) {
      return { kind: 'error', message: `Unknown component "${second}". Expected one of: ${COMPONENTS.join(', ')}, or all.` }
    }
    if (rest.length > 0) return { kind: 'error', message: `Unexpected argument "${rest[0]}".` }
    const component = second && second !== 'all' ? (second as Component) : undefined
    return { kind: 'build', component, dryRun, composeFiles }
  }

  // Per-component command.
  if (!isComponent(head)) {
    return { kind: 'error', message: `Unknown command "${head}". Expected a component (${COMPONENTS.join(', ')}) or up/down/build.` }
  }
  if (second === undefined) {
    return { kind: 'error', message: `"${head}" needs a verb: ${VERBS.join(', ')}.` }
  }
  if (!isVerb(second)) {
    return { kind: 'error', message: `Unknown verb "${second}" for "${head}". Expected one of: ${VERBS.join(', ')}.` }
  }
  if (rest.length > 0) return { kind: 'error', message: `Unexpected argument "${rest[0]}".` }
  return { kind: 'run', component: head, verb: second, dryRun, composeFiles }
}

// ── `spectra attach` ───────────────────────────────────────────────────────────────────────────
// A different shape from the rest: it does not drive the local stack, it runs ONLY the two agent
// runtimes (attach.yaml) and points them at a REMOTE coordinator. Same discipline though — the argv
// translation and option resolution are pure here; cli.ts does the spawning and env injection.

export const ATTACH_AGENTS = ['coder', 'spec', 'both'] as const
export type AttachAgent = (typeof ATTACH_AGENTS)[number]

/** The flags a user may pass to `attach`, before defaults and env are applied. All optional here. */
export interface AttachFlags {
  coordinator?: string
  server?: string
  token?: string
  org?: string
  project?: string
  dir?: string
}

export type AttachParsed =
  | { kind: 'attach'; flags: AttachFlags; agent: AttachAgent; dryRun: boolean; composeFiles: string[] }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** The fully-resolved inputs an attach run needs — flags merged with env and defaults, validated. */
export interface AttachOptions {
  coordinator: string
  server: string
  token: string
  org: string
  project: string
  dir: string
  agent: AttachAgent
}

const ATTACH_VALUE_FLAGS = new Set(['--coordinator', '--server', '--token', '--org', '--project', '--dir', '--agent', '--compose-file'])

/**
 * Parse the argv tail after `attach`. Collects flags without applying defaults or reading env — that
 * is {@link resolveAttach}'s job — so this stays a pure, exhaustively-testable tokenizer. Unknown
 * flags and missing values become an `error`, matching {@link parseArgs}.
 */
export function parseAttachArgs(argv: string[]): AttachParsed {
  const flags: AttachFlags = {}
  const composeFiles: string[] = []
  let agent: AttachAgent = 'both'
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (!ATTACH_VALUE_FLAGS.has(arg)) return { kind: 'error', message: `Unknown option "${arg}".` }
    const value = argv[i + 1]
    if (value === undefined) return { kind: 'error', message: `${arg} needs a value.` }
    i += 1
    if (arg === '--compose-file') {
      composeFiles.push(value)
    } else if (arg === '--agent') {
      if (!(ATTACH_AGENTS as readonly string[]).includes(value)) {
        return { kind: 'error', message: `--agent must be one of: ${ATTACH_AGENTS.join(', ')}.` }
      }
      agent = value as AttachAgent
    } else {
      flags[arg.slice(2) as keyof AttachFlags] = value
    }
  }

  return { kind: 'attach', flags, agent, dryRun, composeFiles }
}

/** The coordinator's HTTP origin — where the runtime's /mcp tool calls go — from its ws(s) relay URL. */
export function deriveServerUrl(coordinator: string): string {
  const url = new URL(coordinator)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:') url.protocol = 'http:'
  return url.origin
}

/**
 * The canonical coordinator origin (scheme + host, no path) for any reasonable input — an `https`/
 * `http`/`ws`/`wss` URL, or a bare host. `wss`/`https` → `https`, `ws`/`http` → `http`, bare → `https`.
 * This is the one identity a coordinator has: the credential key, the `/api` base, and what the relay
 * URL is derived from — so `https://c.example`, `wss://c.example`, and `wss://c.example/api/relay/runtime`
 * all collapse to the same thing. Returns null if the input isn't a parseable host. Pure.
 */
export function coordinatorOrigin(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  const scheme = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : url.protocol === 'ws:' || url.protocol === 'http:' ? 'http:' : null
  if (!scheme || !url.host) return null
  return `${scheme}//${url.host}`
}

/**
 * The relay WebSocket URL the runtime dials, derived from a coordinator origin — so no one ever has to
 * type `/api/relay/runtime` (getting it wrong makes attach dial the SPA and fail). `https`→`wss`,
 * `http`→`ws`. Pure.
 */
export function relayUrl(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api/relay/runtime'
  return url.toString()
}

/**
 * Merge parsed flags with the environment and defaults, and validate. Kept pure by taking `env` and
 * `cwd` as arguments rather than reading them. The token and coordinator may come from the
 * environment (`DEVICE_TOKEN`, `COORDINATOR_URL`) so the panel's printed command can omit the secret
 * and let a shell/`spectra.env` supply it; org defaults to `local`, dir to the working directory.
 */
export function resolveAttach(
  parsed: Extract<AttachParsed, { kind: 'attach' }>,
  env: Record<string, string | undefined>,
  cwd: string,
): { kind: 'ok'; options: AttachOptions } | { kind: 'error'; message: string } {
  const { flags } = parsed
  const rawCoordinator = flags.coordinator ?? env.COORDINATOR_URL
  if (!rawCoordinator) return { kind: 'error', message: 'attach needs --coordinator (a coordinator URL or host).' }
  // Normalize whatever was given (https/http/ws/wss/bare) to the origin, then derive the relay URL the
  // runtime dials — so no one has to type `/api/relay/runtime`, and a bare/https value works.
  const origin = coordinatorOrigin(rawCoordinator)
  if (!origin) return { kind: 'error', message: `--coordinator must be a URL or host, got "${rawCoordinator}".` }
  const coordinator = relayUrl(origin)
  const serverFromCoordinator = origin

  const project = flags.project ?? env.PROJECT_ID
  if (!project) return { kind: 'error', message: 'attach needs --project (the id of the remote project).' }

  const token = flags.token ?? env.DEVICE_TOKEN
  if (!token) return { kind: 'error', message: 'attach needs a device token: pass --token or set DEVICE_TOKEN.' }

  return {
    kind: 'ok',
    options: {
      coordinator,
      server: flags.server ?? env.SERVER_URL ?? serverFromCoordinator,
      token,
      org: flags.org ?? env.ORG ?? 'local',
      project,
      dir: flags.dir ?? cwd,
      agent: parsed.agent,
    },
  }
}

/**
 * The environment attach.yaml interpolates. The model credential is NOT here — it comes from the
 * shared `spectra.env` via `--env-file`, exactly as the stack commands source `ANTHROPIC_API_KEY`.
 */
export function attachEnv(options: AttachOptions): Record<string, string> {
  return {
    COORDINATOR_URL: options.coordinator,
    SERVER_URL: options.server,
    DEVICE_TOKEN: options.token,
    ORG: options.org,
    PROJECT_ID: options.project,
    ATTACH_PROJECT_DIR: options.dir,
  }
}

/** The `docker compose` argv for attach: a foreground `up` (no `-d`) of one agent service or both. */
export function attachComposeArgv(agent: AttachAgent, composeFiles: string[], envFile?: string): string[] {
  const services = agent === 'both' ? [] : [agent]
  return [...topLevelFlags(composeFiles, envFile), 'up', ...services]
}

// ── `spectra login` / `spectra logout` ───────────────────────────────────────────────────────────
// Fetch (or drop) the device token for a coordinator via the browser, so `attach` needs no --token.
// Parsing stays here and pure; the loopback server, browser open, and token exchange live in login.ts.

export type LoginParsed =
  | { kind: 'login'; coordinator?: string; label?: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export type LogoutParsed =
  | { kind: 'logout'; coordinator?: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

const LOGIN_VALUE_FLAGS = new Set(['--coordinator', '--label'])

export function parseLoginArgs(argv: string[]): LoginParsed {
  let coordinator: string | undefined
  let label: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (!LOGIN_VALUE_FLAGS.has(arg)) return { kind: 'error', message: `Unknown option "${arg}".` }
    const value = argv[i + 1]
    if (value === undefined) return { kind: 'error', message: `${arg} needs a value.` }
    i += 1
    if (arg === '--coordinator') coordinator = value
    else label = value
  }
  return { kind: 'login', coordinator, label }
}

export function parseLogoutArgs(argv: string[]): LogoutParsed {
  let coordinator: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg !== '--coordinator') return { kind: 'error', message: `Unknown option "${arg}".` }
    const value = argv[i + 1]
    if (value === undefined) return { kind: 'error', message: '--coordinator needs a value.' }
    i += 1
    coordinator = value
  }
  return { kind: 'logout', coordinator }
}

// ── `spectra projects` ───────────────────────────────────────────────────────────────────────────

export type ProjectsParsed =
  | { kind: 'projects'; coordinator?: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseProjectsArgs(argv: string[]): ProjectsParsed {
  let coordinator: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg !== '--coordinator') return { kind: 'error', message: `Unknown option "${arg}".` }
    const value = argv[i + 1]
    if (value === undefined) return { kind: 'error', message: '--coordinator needs a value.' }
    i += 1
    coordinator = value
  }
  return { kind: 'projects', coordinator }
}

export const PROJECTS_USAGE = `spectra projects — list the projects you can reach on a coordinator

Uses the device token saved by \`spectra login\`. With one login, --coordinator is optional.

Usage:
  spectra projects [--coordinator <ws-url>]

Options:
  --coordinator <url>   coordinator URL or host (https://…, wss://…, or bare host)   (env COORDINATOR_URL; optional once logged in)
  -h, --help            show this help`

export const LOGIN_USAGE = `spectra login — fetch this machine's device token from a coordinator, via the browser

Opens the browser to the coordinator, where you approve this machine; the token comes back over a
local redirect and is saved under ~/.config/spectra/. After that, \`spectra attach\` needs no --token.

Usage:
  spectra login  --coordinator <ws-url> [--label "<name>"]
  spectra logout --coordinator <ws-url>

Options:
  --coordinator <url>   coordinator URL or host (https://…, wss://…, or bare host)   (env COORDINATOR_URL)
  --label "<name>"      a name for this machine (default: the hostname)
  -h, --help            show this help

Example:
  spectra login --coordinator https://<host>`

export const ATTACH_USAGE = `spectra attach — run local agent runtimes against a REMOTE coordinator

Runs the @coder and @spec runtimes in containers (attach.yaml) that dial OUT to a coordinator over
one WebSocket, so a hosted chat drives the agents on your machine. @coder stays sandboxed; it mounts
the project directory and calls the model directly (consumer-pays).

Usage:
  spectra attach --coordinator <ws-url> --project <id> [options]

Required (flag or environment):
  --coordinator <url>   coordinator URL or host (https://…, wss://…, or bare host)   (env COORDINATOR_URL; optional once logged in)
  --project <id>        the remote project's id           (env PROJECT_ID)
  --token <token>       the device token for this machine (env DEVICE_TOKEN, or run \`spectra login\`)

After \`spectra login\`, both --coordinator and --token are inferred from the saved login (the sole one,
or pass --coordinator to choose among several), so attach is just: --org … --project … --dir …

Options:
  --org <slug>          the remote org (default: local)   (env ORG)
  --server <url>        coordinator origin for tool calls (default: derived from --coordinator)
  --dir <path>          project @coder implements into    (default: current directory)
  --agent <which>       coder | spec | both               (default: both)
  --dry-run             print the docker compose command instead of running it
  --compose-file <path> override attach.yaml
  -h, --help            show this help

The model credential (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) is read from
~/.config/spectra/spectra.env, the same file the rest of the CLI uses.

Example:
  spectra attach --coordinator https://<host> --org acme --project acme-9f2 --token <token>`

export const USAGE = `spectra — control the Spectra stack (a thin wrapper over docker compose)

Usage:
  spectra init [--name "<name>"] [--domain "<text>"] [options]   (see: spectra init --help)
  spectra <component> <verb> [options]
  spectra up | down | build [component] [options]
  spectra login  --coordinator <ws-url> [options]               (see: spectra login --help)
  spectra projects [--coordinator <ws-url>]                     (see: spectra projects --help)
  spectra attach --coordinator <ws-url> --project <id> [options] (see: spectra attach --help)

Components:
  server    the coordinator: API + glossary   (compose service: server)
  spec      the @spec agent runtime           (compose service: spec)
  coder     the sandboxed @coder runtime       (compose service: coder)
  web       the web UI                         (compose service: web)

Verbs (per component):
  up        bring the piece up      (docker compose up -d)
  down      stop and remove it      (docker compose rm -sf)
  restart   restart it              (docker compose restart)
  status    show its state          (docker compose ps)
  logs      follow its logs         (docker compose logs -f)

Lifecycle (whole stack):
  up                bring the whole stack up   (docker compose up -d)
  down              tear it all down           (docker compose down)
  build [component] build images            (docker compose build); all pieces if none named

Options:
  --dry-run             print the docker compose command instead of running it
  --compose-file <path> compose file to use; repeat to layer a base and an override
  -h, --help            show this help
  -v, --version         show the version

Examples:
  spectra up
  spectra server logs
  spectra web restart
  spectra build coder`
