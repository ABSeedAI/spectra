/**
 * `spectra init` — link a repo to a Spectra project.
 *
 * Three things live in three places, and init sets up all three (see CLAUDE.md "the corrected
 * picture"):
 *   - the CODE is the user's repo — the only thing @coder mounts and writes;
 *   - the GLOSSARY (specs) is the Server's, stored behind SpecStore. For the FS backend that is a
 *     server-owned directory under the XDG data home, per project — NOT the repo. init creates it
 *     and seeds its project.json (name/domain — identity is store content, per blocker C, not
 *     container env);
 *   - the LINK is `.spectra/config.json` in the repo: a project id + optional Server URL, so this
 *     checkout knows which project it maps to (the git-remote analogy).
 *
 * Projects are keyed by that **id**, never by folder path — move or rename the repo and the id
 * travels with it (the path-keying trap we hit renaming the repo itself).
 *
 * The per-project compose override init writes is layered over default.yaml
 * (`docker compose -f default.yaml -f <override> up`) and supplies exactly the project-specific
 * bits default.yaml leaves out: where the glossary and data live (mounted into `spec`), and what
 * @coder mounts (the repo root by default, or a subdir).
 *
 * planInit is pure — it takes every path as input and returns the files to write — so it is tested
 * without touching the filesystem. applyInitPlan is the thin part that actually writes.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface InitInput {
  /** The repo being linked (usually process.cwd()). */
  repoDir: string
  name: string
  domain: string
  /** Coder's mount, relative to repoDir. Undefined or '.' means the repo root. */
  coderDir?: string
  /** Optional Server URL for the link; local installs talk to the CLI-launched server, so null is fine. */
  server?: string
  /** XDG config home (e.g. ~/.config) and data home (e.g. ~/.local/share); `spectra/…` is appended. */
  configHome: string
  dataHome: string
  /** Pre-generated project id, passed in so planInit stays pure and deterministic in tests. */
  id: string
}

export interface PlannedFile {
  path: string
  content: string
}

export interface InitPlan {
  id: string
  files: PlannedFile[]
  /**
   * Directories that must exist but hold no init-written file — the data dir. If we leave it to
   * `spectra up`, docker auto-creates the bind-mount source as root, and the spec container (which
   * runs as the non-root `node` user) then cannot open its transcripts DB there. Creating it here
   * makes it the user's, and writable.
   */
  dirs: string[]
  /** The server-owned glossary directory (SPECS_DIR maps here inside the spec container). */
  glossaryDir: string
  /** The compose override path the CLI layers over default.yaml. */
  overridePath: string
  /** The absolute host path @coder mounts. */
  coderMount: string
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * The one shared credential file, `<configHome>/spectra/spectra.env`. Shared across projects, not
 * per-project — one place a consumer drops their token — and handed to compose with `--env-file`
 * (cli.ts) so the stack's `${ANTHROPIC_API_KEY}` etc. resolve without any shell export. Path only,
 * so it is pure and the same helper serves both `init` (scaffold) and the run path (find it).
 */
export function credentialFilePath(configHome: string): string {
  return path.join(configHome, 'spectra', 'spectra.env')
}

const CREDENTIAL_SCAFFOLD = `# Spectra credential — handed to the stack on \`spectra up\` (docker compose --env-file).
# Set ONE of these. They are NOT interchangeable: the server checks the prefix on boot, and the
# wrong slot loads fine then fails every call with "Invalid API key".
#
#   Claude subscription token — from \`claude setup-token\` (starts sk-ant-oat…):
# CLAUDE_CODE_OAUTH_TOKEN=
#
#   Console API key — from console.anthropic.com (starts sk-ant-api…):
# ANTHROPIC_API_KEY=
#
# Optional — text-to-speech (ElevenLabs); the browser reads replies aloud when this is set:
# ELEVENLABS_API_KEY=
#
# Optional — git push credential for local @coder (\`spectra attach\`). A personal access token from
# your repo host, so @coder can push its work. Without it, @coder commits locally but can't push.
# GIT_TOKEN=
# GIT_USERNAME=        # optional; defaults to x-access-token
`

/**
 * Create the shared credential file if it does not exist, so `spectra init` leaves an obvious place
 * for the token. Never overwrites — a second `init` must not clobber a real credential. Written
 * 0600 (it holds a secret; chmod after write because the file mode is subject to umask). Returns the
 * path when it wrote one, null when it was already there.
 */
export function ensureCredentialFile(configHome: string): string | null {
  const file = credentialFilePath(configHome)
  if (existsSync(file)) return null
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, CREDENTIAL_SCAFFOLD, { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

/** Build the compose override YAML — small and fixed, so it is templated rather than serialized. */
function overrideYaml(input: {
  id: string
  name: string
  glossaryDir: string
  dataDir: string
  coderMount: string
}): string {
  return `# Generated by \`spectra init\` for ${input.name}.
# Layered over the distribution base:  docker compose -f default.yaml -f <this> up -d
# Holds only the project-specific bits default.yaml leaves out — the glossary/data the server
# owns, and what @coder mounts. Host paths are absolute because compose resolves volume paths
# relative to this file, not the repo.
name: spectra-${input.id}
services:
  server:
    volumes:
      # Under a <id>/ dir so the server derives projectId "${input.id}" (<root>/<projectId>/specs) —
      # the same id the agent runtimes carry in their MCP URL and the UI shows.
      - "${input.glossaryDir}:/stack/${input.id}/specs"
      - "${input.dataDir}:/stack/data"
    environment:
      - SPECS_DIR=/stack/${input.id}/specs
      - DATA_DIR=/stack/data
  coder:
    volumes:
      # The code @coder implements into. It never sees the glossary — that arrives as tool calls.
      - "${input.coderMount}:/work/project"
    environment:
      # The project this runtime is bound to — carried in its per-project MCP URL so the profile
      # and tool calls act on this project's glossary (/mcp/orgs/local/projects/${input.id}/coder).
      - ORG=local
      - PROJECT_ID=${input.id}
  spec:
    environment:
      # Same for the @spec runtime — it fetches this project's @spec profile and tools. No mount:
      # @spec has no filesystem tools; the glossary reaches it over MCP like it does @coder.
      - ORG=local
      - PROJECT_ID=${input.id}
`
}

export function planInit(input: InitInput): InitPlan {
  const spectraConfig = path.join(input.configHome, 'spectra')
  const projectConfigDir = path.join(spectraConfig, 'projects', input.id)
  const overridePath = path.join(projectConfigDir, 'compose.yaml')

  const projectDataDir = path.join(input.dataHome, 'spectra', 'projects', input.id)
  const glossaryDir = path.join(projectDataDir, 'specs')
  const dataDir = path.join(projectDataDir, 'data')

  const coderMount =
    input.coderDir && input.coderDir !== '.'
      ? path.resolve(input.repoDir, input.coderDir)
      : input.repoDir

  const files: PlannedFile[] = [
    {
      // The link, committed with the repo.
      path: path.join(input.repoDir, '.spectra', 'config.json'),
      content: json({
        id: input.id,
        name: input.name,
        domain: input.domain,
        coderDir: input.coderDir ?? '.',
        server: input.server ?? null,
      }),
    },
    {
      // Seed the server-side glossary's identity. The glossary is otherwise empty (ships empty).
      path: path.join(glossaryDir, 'project.json'),
      content: json({ name: input.name, domain: input.domain }),
    },
    {
      path: overridePath,
      content: overrideYaml({ id: input.id, name: input.name, glossaryDir, dataDir, coderMount }),
    },
  ]

  // The data dir holds no init-written file, so it must be created explicitly — otherwise docker
  // makes it root-owned at `up` time and the non-root spec container cannot write its transcripts DB.
  return { id: input.id, files, dirs: [dataDir], glossaryDir, overridePath, coderMount }
}

/** Write a plan to disk, creating parent directories. Pure planning stays in planInit. */
export function applyInitPlan(plan: InitPlan): void {
  for (const dir of plan.dirs) {
    mkdirSync(dir, { recursive: true })
  }
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.content)
  }
}

export interface InitOptions {
  /** Undefined when not given — the caller defaults both to the repo folder name. */
  name?: string
  domain?: string
  coderDir?: string
  server?: string
  force: boolean
  dryRun: boolean
}

export type InitParse =
  | { kind: 'ok'; options: InitOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** Parse `init`'s own flags (name/domain/dir/server/force/dry-run). name and domain are required. */
export function parseInitArgs(argv: string[]): InitParse {
  const flags: Record<string, string> = {}
  let force = false
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '--force') {
      force = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--name' || arg === '--domain' || arg === '--dir' || arg === '--server') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) return { kind: 'error', message: `${arg} needs a value.` }
      flags[arg.slice(2)] = value
      i += 1
    } else {
      return { kind: 'error', message: `Unknown argument "${arg}" for init.` }
    }
  }

  return {
    kind: 'ok',
    options: {
      // Both optional — the caller fills them from the repo folder name when absent.
      name: flags.name,
      domain: flags.domain,
      coderDir: flags.dir,
      server: flags.server,
      force,
      dryRun,
    },
  }
}

export const INIT_USAGE = `spectra init — link this repo to a Spectra project

Usage:
  spectra init [--name "<name>"] [--domain "<what the glossary describes>"] [options]

Options:
  --name <name>      the project's name         (default: the repo folder name)
  --domain <text>    what the glossary is about (default: the repo folder name)
  --dir <subdir>     what @coder mounts, relative to the repo (default: the repo root)
  --server <url>     Server URL for the link   (default: none — a local install uses the CLI's)
  --force            overwrite an existing .spectra/config.json
  --dry-run          show what would be written, without writing
  -h, --help         show this help

Writes: .spectra/config.json (the link), the server-side glossary's project.json, and a
per-project compose override under ~/.config/spectra/projects/<id>/.`
