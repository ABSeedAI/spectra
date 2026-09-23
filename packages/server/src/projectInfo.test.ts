/**
 * projectInfo() is the store's answer to "who is this glossary" — read from specs/project.json by
 * the filesystem backend, and the source the agent prompt and the UI title both template from.
 *
 * Two things matter and are checked here: a valid file comes back verbatim, and anything the store
 * cannot read (missing, non-JSON, wrong shape) degrades to a neutral default rather than throwing —
 * a bad hand-edit must not take down the server or hand the agents a half-parsed identity. The
 * default is deliberately generic so an unconfigured glossary never borrows another project's name.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Term } from '@abseed/spectra-core'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import { buildAgents } from './agent/agents.js'

// The store scopes to <root>/<projectId>/specs; `specs` is that dir, where project.json is written.
let root: string
let specs: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tb-project-'))
  specs = path.join(root, 'proj', 'specs')
  await mkdir(specs, { recursive: true })
})

describe('FileSystemSpecStore.projectInfo', () => {
  it('reads name and domain from specs/project.json', async () => {
    await writeFile(
      path.join(specs, 'project.json'),
      JSON.stringify({ name: 'Todo Blueprints', domain: 'a ToDo app' }),
    )
    const info = await new FileSystemSpecStore(root, 'proj').projectInfo()
    expect(info).toEqual({ name: 'Todo Blueprints', domain: 'a ToDo app' })
  })

  it('falls back to a neutral default when the file is absent', async () => {
    const info = await new FileSystemSpecStore(root, 'proj').projectInfo()
    expect(info.name).toBe('Untitled project')
    // The fallback must not smuggle a real project's identity back in.
    expect(info.name).not.toMatch(/todo/i)
  })

  it('falls back rather than throwing when the file is not valid JSON', async () => {
    await writeFile(path.join(specs, 'project.json'), '{ not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = await new FileSystemSpecStore(root, 'proj').projectInfo()
    expect(info.name).toBe('Untitled project')
  })

  it('falls back when the JSON is the wrong shape', async () => {
    await writeFile(path.join(specs, 'project.json'), JSON.stringify({ name: 'X' })) // no domain
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = await new FileSystemSpecStore(root, 'proj').projectInfo()
    expect(info.name).toBe('Untitled project')
  })

  it('reads the System Brief when present (GH #143)', async () => {
    await writeFile(
      path.join(specs, 'project.json'),
      JSON.stringify({ name: 'Gamify', domain: 'a gamification API', brief: 'An HTTP API, no UI.' }),
    )
    const info = await new FileSystemSpecStore(root, 'proj').projectInfo()
    expect(info).toEqual({ name: 'Gamify', domain: 'a gamification API', brief: 'An HTTP API, no UI.' })
  })

  it('setProjectBrief writes then clears the brief, preserving name/domain (GH #143)', async () => {
    await writeFile(path.join(specs, 'project.json'), JSON.stringify({ name: 'Gamify', domain: 'a gamification API' }))
    const store = new FileSystemSpecStore(root, 'proj')
    await store.setProjectBrief('An HTTP API, no UI.')
    expect(await store.projectInfo()).toEqual({ name: 'Gamify', domain: 'a gamification API', brief: 'An HTTP API, no UI.' })
    await store.setProjectBrief('')
    expect(await store.projectInfo()).toEqual({ name: 'Gamify', domain: 'a gamification API' })
  })
})

describe('FileSystemSpecStore.commitApplication against an empty store', () => {
  it('creates terms/ on the first apply rather than ENOENTing', async () => {
    // A store the engine ships with: no terms/ dir exists yet. The first applied changeset
    // must create it, the same way every other write here mkdirs its dir first.
    const term: Term = {
      name: 'Widget',
      type: 'entity',
      spec: 'A widget.',
      parent: null,
      tags: [],
      attributes: [],
    }
    const store = new FileSystemSpecStore(root, 'proj')
    // The pending changeset writer mkdirs changesets/ — but terms/ still does not exist.
    await store.addChangeset({ id: 'cs-first', summary: 'add Widget', ops: [], tests: [] })
    const result = await store.commitApplication({
      changesetId: 'cs-first',
      nextTerms: [term],
      appliedOps: [],
      remainingOps: [],
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    if ('conflict' in result) throw new Error('unexpected conflict')
    expect(result.written).toContain('widget.json')
    const glossary = await store.readTerms()
    expect(glossary.terms.map((t) => t.name)).toContain('Widget')
  })
})

describe('buildAgents', () => {
  it('names the project and its domain in the shared prompt of both agents', () => {
    const agents = buildAgents({ name: 'Acme Specs', domain: 'a billing system' })
    for (const agent of [agents.spec, agents.coder]) {
      expect(agent.systemPrompt).toContain('Acme Specs')
      expect(agent.systemPrompt).toContain('a billing system')
      // The old hardcoded identity is gone.
      expect(agent.systemPrompt).not.toContain('todo-blueprints')
    }
  })
})
