/**
 * The two agent definitions, bound to this host's filesystem.
 *
 * The definitions themselves — who `@spec` and `@coder` are, their prompts and tool lists — live in
 * `@abseed/spectra-agent-tools` so both coordinators (this server and the hosted Worker) serve the same
 * single source. This module supplies the one thing that is host-specific: the filesystem paths those
 * definitions reference — the glossary dir and @coder's working dir — and re-exports the roster so
 * every caller keeps importing agents from here.
 */
import path from 'node:path'
import type { ProjectInfo } from '@abseed/spectra-core'
import { buildAgents as buildAgentsFor } from '@abseed/spectra-agent-tools'
import type { AgentDefinition, AgentName } from '@abseed/spectra-agent-tools'
import { SPECS_DIR } from '../config.js'

export type { AgentDefinition, AgentName }
export { AGENT_NAMES } from '@abseed/spectra-agent-tools'

const REPO = path.resolve(SPECS_DIR, '..')
// The project the in-process (unsandboxed) @coder implements into — its cwd. Configurable via
// CODER_DIR; the default sits beside the glossary, which is where a bare checkout would keep it.
// (The sandboxed @coder uses its own container path instead — APP_DIR in packages/runtime/src/main.ts.)
const APP_DIR = process.env.CODER_DIR ?? path.join(REPO, 'app')

// Opt-in (GH #136): the repo @spec may read, read-only, to surface specs from existing code and verify
// against it. Unset ⇒ @spec stays code-blind (no filesystem), exactly as before. Mirrors CODER_DIR; a
// sandboxed/attached deployment supplies this as a read-only mount, an in-process run points it at a
// checkout on disk.
const SPEC_CODE_DIR = process.env.SPEC_CODE_DIR
// Opt-in reference tools for @spec (GH #145). Off unless set; a hosted deployment gates these with a
// per-project toggle instead. `1`/`true` enables.
const on = (v: string | undefined): boolean => v === '1' || v === 'true'
const SPEC_WEB_FETCH = on(process.env.SPEC_WEB_FETCH)
const SPEC_WEB_SEARCH = on(process.env.SPEC_WEB_SEARCH)

/** This server's agents: the shared definitions, bound to this host's specs and app directories. */
export function buildAgents(project: ProjectInfo): Record<AgentName, AgentDefinition> {
  return buildAgentsFor(project, {
    specsDir: SPECS_DIR,
    appDir: APP_DIR,
    ...(SPEC_CODE_DIR ? { specCodeDir: SPEC_CODE_DIR } : {}),
    ...(SPEC_WEB_FETCH ? { specWebFetch: true } : {}),
    ...(SPEC_WEB_SEARCH ? { specWebSearch: true } : {}),
  })
}
