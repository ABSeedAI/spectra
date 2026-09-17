/**
 * The entry point: read argv, translate it (commands.ts), and shell out to `docker compose`.
 *
 * This file owns everything impure — resolving the compose file, spawning docker, exit codes —
 * and nothing else. The translation it drives is pure and tested separately, so the only things
 * that can go wrong here are the ones that need a real machine: docker missing, or a non-zero
 * exit from compose itself, both of which are reported plainly.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ATTACH_USAGE,
  attachComposeArgv,
  attachEnv,
  composeArgv,
  composeBuildArgv,
  composeStackArgv,
  coordinatorOrigin,
  relayUrl,
  parseArgs,
  parseAttachArgs,
  parseProjectsArgs,
  PROJECTS_USAGE,
  resolveAttach,
  USAGE,
} from './commands.js'
import { discover, resolveComposeFiles } from './discovery.js'
import { INIT_USAGE, applyInitPlan, credentialFilePath, ensureCredentialFile, parseInitArgs, planInit } from './init.js'
import { runLogin, runLogout } from './login.js'
import { readCredentials, tokenFor } from './credentials.js'

/** Repo-root path resolved relative to this package (packages/cli/src -> repo root). */
function repoFile(name: string): string {
  return path.resolve(import.meta.dirname, '../../..', name)
}

/**
 * The attach compose file. An install has no working tree, so `install.sh` scaffolds the distribution
 * variant (git build context) to `~/.config/spectra/attach.yaml`; prefer that. A checkout falls back
 * to the repo's `attach.yaml` (which builds the runtime image from the working tree). Mirrors how
 * `default.yaml` is resolved for the stack commands.
 */
function attachComposeFile(): string {
  const installed = path.join(configHome(), 'spectra', 'attach.yaml')
  return existsSync(installed) ? installed : repoFile('attach.yaml')
}

/**
 * The compose files a command runs against. Explicit `--compose-file` flags win; then
 * SPECTRA_COMPOSE_FILE; then auto-discovery of a linked project (`default.yaml` + its override);
 * then the contributors' `docker-compose.yml`. See discovery.ts for the precedence.
 */
function composeFilesFor(explicit: string[]): string[] {
  return resolveComposeFiles({
    explicit,
    envFile: process.env.SPECTRA_COMPOSE_FILE,
    discovered: discover(process.cwd(), configHome(), repoFile('default.yaml')),
    fallback: repoFile('docker-compose.yml'),
  })
}

declare const __SPECTRA_VERSION__: string | undefined
function version(): string {
  // The bundled build inlines the version (esbuild `define`); running from source (tsx) has no
  // such constant and reads package.json instead — a single-file bundle has no package.json beside it.
  if (typeof __SPECTRA_VERSION__ !== 'undefined') return __SPECTRA_VERSION__
  return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version as string
}

/** XDG homes, matching how the server resolves DATA_DIR. */
function configHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}
function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
}

/** A readable, stable, collision-resistant id: the repo folder name plus a short random suffix. */
function newProjectId(repoDir: string): string {
  const base = path.basename(repoDir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return `${base}-${randomBytes(3).toString('hex')}`
}

function runInit(argv: string[]): number {
  const parsed = parseInitArgs(argv)
  if (parsed.kind === 'help') {
    console.log(INIT_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    console.error(parsed.message)
    console.error('\nRun `spectra init --help` for usage.')
    return 2
  }

  const repoDir = process.cwd()
  const linkPath = path.join(repoDir, '.spectra', 'config.json')
  if (existsSync(linkPath) && !parsed.options.force) {
    console.error(`${linkPath} already exists. Re-run with --force to overwrite.`)
    return 1
  }

  // Both default to the repo folder name; edit them later in the glossary's project.json.
  const folder = path.basename(repoDir)
  const plan = planInit({
    repoDir,
    name: parsed.options.name ?? folder,
    domain: parsed.options.domain ?? folder,
    coderDir: parsed.options.coderDir,
    server: parsed.options.server,
    configHome: configHome(),
    dataHome: dataHome(),
    id: newProjectId(repoDir),
  })

  if (parsed.options.dryRun) {
    console.log(`Would write (project ${plan.id}):`)
    for (const file of plan.files) console.log(`  ${file.path}`)
    return 0
  }

  applyInitPlan(plan)
  // The shared credential file, scaffolded once so there is an obvious place for the token. It is
  // never per-project and never overwritten, so a second init leaves an existing credential alone.
  const scaffolded = ensureCredentialFile(configHome())
  console.log(`Initialized Spectra project ${plan.id}.`)
  console.log(`  link:     ${linkPath}`)
  console.log(`  glossary: ${plan.glossaryDir}`)
  console.log(`  coder:    ${plan.coderMount}`)
  console.log(`  credential: ${credentialFilePath(configHome())}${scaffolded ? ' (add your Anthropic token here)' : ''}`)
  console.log('\nStart it from this repo with:  spectra up')
  return 0
}

/**
 * The coordinator a command acts against: an explicit `--coordinator`/`COORDINATOR_URL` wins; else,
 * if `spectra login` saved exactly one, that; else an error (none, or several to choose among).
 * Shared by `attach` and `projects` so "you're logged into one place" means the flag is optional.
 */
function resolveCoordinator(flag: string | undefined): { origin: string } | { error: string } {
  const chosen = flag ?? process.env.COORDINATOR_URL
  if (chosen) {
    const origin = coordinatorOrigin(chosen)
    return origin ? { origin } : { error: `Not a valid coordinator URL or host: "${chosen}".` }
  }
  const origins = [...new Set(Object.values(readCredentials(configHome())).map((c) => coordinatorOrigin(c.coordinator)).filter((o): o is string => !!o))]
  if (origins.length === 1) return { origin: origins[0]! }
  if (origins.length === 0) return { error: 'No coordinator: pass --coordinator, or run `spectra login` first.' }
  return { error: `Several coordinators are logged in — pass --coordinator to pick one:\n${origins.map((o) => `  ${o}`).join('\n')}` }
}

/**
 * `spectra projects` — list the projects reachable on a coordinator, using the device token saved by
 * `spectra login`. Reads GET /api/cli/projects (device-token authed) and prints org/id + name, so a
 * viewer no longer needs a DevTools `/api/context` lookup to fill `attach --org … --project …`.
 */
async function runProjects(argv: string[]): Promise<number> {
  const parsed = parseProjectsArgs(argv)
  if (parsed.kind === 'help') {
    console.log(PROJECTS_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    console.error(parsed.message)
    console.error('\nRun `spectra projects --help` for usage.')
    return 2
  }

  const coord = resolveCoordinator(parsed.coordinator)
  if ('error' in coord) {
    console.error(coord.error)
    return 2
  }
  const origin = coord.origin
  const token = tokenFor(configHome(), origin)
  if (!token) {
    console.error(`Not logged in to ${origin}. Run:  spectra login --coordinator ${origin}`)
    return 1
  }

  let res: Response
  try {
    res = await fetch(`${origin}/api/cli/projects`, { headers: { authorization: `Bearer ${token}` } })
  } catch {
    console.error(`Could not reach ${origin}.`)
    return 1
  }
  const body = (await res.json().catch(() => ({}))) as { projects?: Array<{ org: string; id: string; name: string }>; error?: string }
  if (!res.ok) {
    console.error(body.error ?? `Could not list projects (${res.status}).`)
    return 1
  }
  const projects = body.projects ?? []
  if (projects.length === 0) {
    console.log(`No projects on ${origin} yet — create one in the app.`)
    return 0
  }

  console.log(`Projects on ${origin}:`)
  for (const project of projects) {
    console.log(`  ${project.org}/${project.id}  —  ${project.name}`)
    console.log(`      spectra attach --org ${project.org} --project ${project.id} --agent coder`)
  }
  console.log('\n(run the line under a project from the repo you want @coder to work in)')
  return 0
}

/**
 * `spectra attach` — run the two agent runtimes (attach.yaml) pointed at a remote coordinator.
 * Unlike the stack commands this injects the resolved coordinator/token/project into the child's
 * environment (attach.yaml interpolates them) and runs compose in the foreground, so the agents'
 * logs stream and Ctrl-C stops them. The model credential still rides in via `--env-file`.
 */
function runAttach(argv: string[]): Promise<number> | number {
  const parsed = parseAttachArgs(argv)
  if (parsed.kind === 'help') {
    console.log(ATTACH_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    console.error(parsed.message)
    console.error('\nRun `spectra attach --help` for usage.')
    return 2
  }

  // Resolve the coordinator (flag/env, else the sole saved login) and inject it + its stored token
  // into the env resolveAttach reads — so a logged-in user runs `attach --org … --project …` bare.
  const coord = resolveCoordinator(parsed.flags.coordinator)
  if ('error' in coord) {
    console.error(coord.error)
    console.error('\nRun `spectra attach --help` for usage.')
    return 2
  }
  // Derive the relay URL (…/api/relay/runtime) from the origin, so no one has to type the path and a
  // bare/https login still dials the right endpoint.
  const patch: Record<string, string> = { COORDINATOR_URL: relayUrl(coord.origin) }
  if (!process.env.DEVICE_TOKEN) {
    const stored = tokenFor(configHome(), coord.origin)
    if (stored) patch.DEVICE_TOKEN = stored
  }

  const resolved = resolveAttach(parsed, { ...process.env, ...patch }, process.cwd())
  if (resolved.kind === 'error') {
    console.error(resolved.message)
    console.error('\nRun `spectra attach --help` for usage.')
    return 2
  }
  const { options } = resolved

  const composeFiles = parsed.composeFiles.length > 0 ? parsed.composeFiles : [attachComposeFile()]
  const credential = credentialFilePath(configHome())
  const envFile = existsSync(credential) ? credential : undefined
  const args = attachComposeArgv(options.agent, composeFiles, envFile, options.build)
  // SPECTRA_REF pins the compose build context (the runtime image source); only meaningful on a build.
  const env = { ...attachEnv(options), ...(options.ref ? { SPECTRA_REF: options.ref } : {}) }

  if (parsed.dryRun) {
    console.log(['docker', 'compose', ...args].join(' '))
    // Show what would be injected, with the token masked — this line is safe to paste in a doc.
    const shown = { ...env, DEVICE_TOKEN: `${options.token.slice(0, 4)}…(${options.token.length} chars)` }
    for (const [key, value] of Object.entries(shown)) console.log(`  ${key}=${value}`)
    return 0
  }
  return runDockerCompose(args, env)
}

async function main(): Promise<number> {
  if (process.argv[2] === 'init') return runInit(process.argv.slice(3))
  if (process.argv[2] === 'attach') return runAttach(process.argv.slice(3))
  if (process.argv[2] === 'login') return runLogin(process.argv.slice(3), configHome())
  if (process.argv[2] === 'logout') return runLogout(process.argv.slice(3), configHome())
  if (process.argv[2] === 'projects') return runProjects(process.argv.slice(3))

  const parsed = parseArgs(process.argv.slice(2))

  switch (parsed.kind) {
    case 'help':
      console.log(USAGE)
      return 0
    case 'version':
      console.log(version())
      return 0
    case 'error':
      console.error(parsed.message)
      console.error('\nRun `spectra --help` for usage.')
      return 2
    case 'run':
    case 'stack':
    case 'build': {
      const composeFiles = composeFilesFor(parsed.composeFiles)
      // Hand compose the shared credential file when it exists, so ${ANTHROPIC_API_KEY} etc. resolve
      // without a shell export. Only when present — `--env-file` at a missing path makes compose error.
      const credential = credentialFilePath(configHome())
      const envFile = existsSync(credential) ? credential : undefined
      const args =
        parsed.kind === 'run'
          ? composeArgv(parsed.component, parsed.verb, composeFiles, envFile)
          : parsed.kind === 'stack'
            ? composeStackArgv(parsed.action, composeFiles, envFile)
            : composeBuildArgv(parsed.component, composeFiles, envFile)
      if (parsed.dryRun) {
        console.log(['docker', 'compose', ...args].join(' '))
        return 0
      }
      return runDockerCompose(args)
    }
  }
}

/**
 * Spawn `docker compose <args>`, inheriting stdio so logs/prompts pass straight through. Extra env
 * (attach injects the coordinator/token/project here) is layered over the parent's — secrets travel
 * in the environment, never in argv, so they stay out of `ps` and shell history.
 */
function runDockerCompose(args: string[], extraEnv?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    })
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error('docker not found on PATH. Spectra drives the stack through docker compose — install Docker first.')
      } else {
        console.error(`Failed to run docker compose: ${error.message}`)
      }
      resolve(127)
    })
    child.on('close', (code) => resolve(code ?? 0))
  })
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
