import { describe, expect, it } from 'vitest'
import { buildAgents } from './agents.js'

const project = { name: 'Shop', domain: 'online shopping' }
const paths = { specsDir: '/data/specs', appDir: '/work/project' }

describe('buildAgents — System Brief injection (GH #143)', () => {
  it('injects the brief into both agents when present', () => {
    const briefed = { ...project, brief: 'An HTTP API for gamification; no UI of its own.' }
    const { spec, coder } = buildAgents(briefed, paths)
    for (const agent of [spec, coder]) {
      expect(agent.systemPrompt).toContain('System Brief')
      expect(agent.systemPrompt).toContain('An HTTP API for gamification; no UI of its own.')
    }
  })

  it('omits the brief section entirely when absent', () => {
    const { spec, coder } = buildAgents(project, paths)
    for (const agent of [spec, coder]) {
      expect(agent.systemPrompt).not.toContain('System Brief')
    }
  })
})

describe('buildAgents — writes-before-prose guidance (GH #156)', () => {
  it('tells both agents to emit the tool call before the long prose and to split large writes', () => {
    const { spec, coder } = buildAgents(project, paths)
    for (const agent of [spec, coder]) {
      expect(agent.systemPrompt).toContain('Make your writes before your prose')
      expect(agent.systemPrompt).toMatch(/split it into several smaller writes/i)
    }
  })
})

describe('buildAgents — ADR discipline (GH #144)', () => {
  it('teaches @coder the ADR bar, the record-vs-surface split, and where they live', () => {
    const { coder } = buildAgents(project, paths)
    expect(coder.systemPrompt).toContain('docs/adr/')
    expect(coder.systemPrompt).toContain('append-only')
    // The four-part shape and the significance framing.
    expect(coder.systemPrompt).toContain('Consequences')
    expect(coder.systemPrompt).toMatch(/hard or expensive to reverse/i)
  })

  it('does not put ADRs on @spec — they are @coder-owned (implementation side)', () => {
    const { spec } = buildAgents(project, paths)
    expect(spec.systemPrompt).not.toContain('docs/adr/')
  })
})

describe('buildAgents — @spec code access (GH #136)', () => {
  it('is code-blind by default: no filesystem, cwd on the glossary', () => {
    const { spec } = buildAgents(project, paths)
    expect(spec.builtins).toEqual([])
    expect(spec.autoApprove).toEqual([])
    expect(spec.cwd).toBe('/data/specs')
    expect(spec.systemPrompt).not.toContain("read the project's code")
  })

  it('with specCodeDir: read-only tools, cwd on the code, and the intent/slice guidance', () => {
    const { spec } = buildAgents(project, { ...paths, specCodeDir: '/work/repo' })
    expect(spec.builtins).toEqual(['Read', 'Glob', 'Grep'])
    // Read-only by construction: the read tools auto-approve, and no write/shell tool is present.
    expect(spec.autoApprove).toEqual(['Read', 'Glob', 'Grep'])
    for (const forbidden of ['Bash', 'Edit', 'Write']) {
      expect(spec.builtins).not.toContain(forbidden)
    }
    expect(spec.cwd).toBe('/work/repo')
    expect(spec.systemPrompt).toContain('/work/repo')
    expect(spec.systemPrompt).toContain("read the project's code")
    expect(spec.systemPrompt).toContain('slice by slice')
    expect(spec.systemPrompt).toContain('intent') // intent-vs-implementation discipline
  })

  it('leaves @coder unchanged whether or not @spec reads code', () => {
    const withoutCode = buildAgents(project, paths).coder
    const withCode = buildAgents(project, { ...paths, specCodeDir: '/work/repo' }).coder
    expect(withCode).toEqual(withoutCode)
    expect(withCode.builtins).toContain('Bash')
  })

  it('still cannot propose changesets from @coder, or edit terms from @spec (unchanged reach)', () => {
    const { spec, coder } = buildAgents(project, { ...paths, specCodeDir: '/work/repo' })
    // Code access does not hand @spec any write-the-code power, nor @coder authorship.
    expect(spec.domainTools).toContain('propose_changeset')
    expect(coder.domainTools).not.toContain('propose_changeset')
  })
})

describe('buildAgents — @spec reference tools (GH #145)', () => {
  it('grants no web tools by default', () => {
    const { spec } = buildAgents(project, paths)
    expect(spec.builtins).not.toContain('WebFetch')
    expect(spec.builtins).not.toContain('WebSearch')
  })

  it('grants WebFetch (auto-approved) with reference-not-authority guidance when specWebFetch is on', () => {
    const { spec } = buildAgents(project, { ...paths, specWebFetch: true })
    expect(spec.builtins).toContain('WebFetch')
    expect(spec.autoApprove).toContain('WebFetch')
    expect(spec.builtins).not.toContain('WebSearch') // independent grant
    expect(spec.systemPrompt).toContain('fetch a URL')
    expect(spec.systemPrompt).toContain('reference, not authority')
  })

  it('grants WebSearch independently', () => {
    const { spec } = buildAgents(project, { ...paths, specWebSearch: true })
    expect(spec.builtins).toContain('WebSearch')
    expect(spec.builtins).not.toContain('WebFetch')
    expect(spec.systemPrompt).toContain('search the web')
  })

  it('combines with code access (read tools + web tools, still no write/shell)', () => {
    const { spec } = buildAgents(project, { ...paths, specCodeDir: '/work/repo', specWebFetch: true, specWebSearch: true })
    expect(spec.builtins).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
    for (const forbidden of ['Bash', 'Edit', 'Write']) expect(spec.builtins).not.toContain(forbidden)
  })

  it('always tells the user missing tools can be enabled in Agents settings (even with none granted)', () => {
    const { spec } = buildAgents(project, paths)
    expect(spec.systemPrompt).toContain('enable it for this project in the Agents settings')
  })
})
