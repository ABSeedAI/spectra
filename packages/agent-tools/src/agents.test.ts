import { describe, expect, it } from 'vitest'
import { buildAgents } from './agents.js'

const project = { name: 'Shop', domain: 'online shopping' }
const paths = { specsDir: '/data/specs', appDir: '/work/project' }

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
