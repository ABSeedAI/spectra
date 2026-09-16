import { describe, expect, it } from 'vitest'
import { toMermaid } from './mermaid.js'
import type { Expectation, Term } from './types.js'

function term(partial: Partial<Term> & { name: string }): Term {
  return { type: 'entity', spec: '', parent: null, tags: [], attributes: [], ...partial }
}

function expectation(partial: Partial<Expectation> & { id: string }): Expectation {
  return {
    kind: 'functional',
    terms: [],
    given: '',
    expect: '',
    raisedBy: { pass: 'usage' },
    supersededBy: null,
    contested: [],
    ...partial,
  }
}

describe('toMermaid', () => {
  it('emits a classDiagram header with the default LR direction', () => {
    const out = toMermaid([])
    expect(out).toBe('classDiagram\n  direction LR')
  })

  it('honours an overridden direction', () => {
    expect(toMermaid([], { direction: 'TB' })).toContain('direction TB')
  })

  it('renders a term as a class with its type stereotype and primitive members', () => {
    const out = toMermaid([
      term({
        name: 'Task',
        attributes: [
          { name: 'title', valueType: 'string' },
          { name: 'done', valueType: 'boolean' },
        ],
      }),
    ])
    expect(out).toContain('class Task {')
    expect(out).toContain('<<entity>>')
    expect(out).toContain('+title string')
    expect(out).toContain('+done boolean')
  })

  it('marks a primitive array member with a [] suffix', () => {
    const out = toMermaid([term({ name: 'Post', attributes: [{ name: 'tags', valueType: 'string[]' }] })])
    expect(out).toContain('+tags string[]')
  })

  it('draws parent as a generalization edge (Parent <|-- Child)', () => {
    const out = toMermaid([term({ name: 'Task' }), term({ name: 'RecurringTask', parent: 'Task' })])
    expect(out).toContain('Task <|-- RecurringTask')
  })

  it('draws a ref attribute as an association labelled by the attribute, not as a member', () => {
    const out = toMermaid([
      term({ name: 'Task', attributes: [{ name: 'project', valueType: 'ref:Project' }] }),
      term({ name: 'Project' }),
    ])
    expect(out).toContain('Task --> Project : project')
    // The reference is an edge only — it must not also appear as a class member.
    expect(out).not.toContain('+project')
  })

  it('adds a "*" multiplicity for an array ref', () => {
    const out = toMermaid([
      term({ name: 'Project', attributes: [{ name: 'tasks', valueType: 'ref:Task[]' }] }),
      term({ name: 'Task' }),
    ])
    expect(out).toContain('Project --> "*" Task : tasks')
  })

  it('flags a referenced-but-missing term with a <<missing>> stub and still draws the edge', () => {
    const out = toMermaid([term({ name: 'Task', attributes: [{ name: 'owner', valueType: 'ref:User' }] })])
    expect(out).toContain('class User {')
    expect(out).toContain('<<missing>>')
    expect(out).toContain('Task --> User : owner')
  })

  it('sanitizes a non-identifier name to a safe id and keeps the real name as a label', () => {
    const out = toMermaid([term({ name: 'My Thing' })])
    expect(out).toContain('class My_Thing["My Thing"]')
  })

  it('draws an expectation as a node stereotyped by kind with a dashed dependency to its terms', () => {
    const out = toMermaid([term({ name: 'Task' })], {
      expectations: [expectation({ id: 'e-001', kind: 'functional', terms: ['Task'] })],
    })
    expect(out).toContain('class e_001["e-001"]')
    expect(out).toContain('<<functional>>')
    expect(out).toContain('e_001 ..> Task')
  })

  it('stubs a term an expectation names but the glossary lacks', () => {
    const out = toMermaid([], { expectations: [expectation({ id: 'e-002', terms: ['Ghost'] })] })
    expect(out).toContain('class Ghost {')
    expect(out).toContain('<<missing>>')
    expect(out).toContain('e_002 ..> Ghost')
  })

  it('shows a non-functional expectation with no terms as a floating node (no edges)', () => {
    const out = toMermaid([], {
      expectations: [expectation({ id: 'e-003', kind: 'non-functional', terms: [] })],
    })
    expect(out).toContain('<<non-functional>>')
    expect(out).not.toContain('..>')
  })

  it('omits a retired (superseded) expectation', () => {
    const out = toMermaid([term({ name: 'Task' })], {
      expectations: [expectation({ id: 'e-004', terms: ['Task'], supersededBy: 'e-009' })],
    })
    expect(out).not.toContain('e_004')
  })

  describe('focus', () => {
    const g = [
      term({ name: 'Project', attributes: [{ name: 'tasks', valueType: 'ref:Task[]' }] }),
      term({ name: 'Task', attributes: [{ name: 'project', valueType: 'ref:Project' }] }),
      term({ name: 'RecurringTask', parent: 'Task', attributes: [{ name: 'priority', valueType: 'ref:Priority' }] }),
      term({ name: 'Priority', type: 'attribute-type' }),
      term({ name: 'Unrelated' }),
    ]

    it('keeps the term and its one-hop neighbourhood, drops the rest', () => {
      const out = toMermaid(g, { focus: 'Task' })
      expect(out).toContain('class Task {')
      expect(out).toContain('class Project {') // Task references it (and is referenced back)
      expect(out).toContain('class RecurringTask {') // subtype of Task
      expect(out).not.toContain('class Unrelated') // no connection to Task
      expect(out).not.toContain('class Priority') // two hops away (via RecurringTask)
    })

    it('drops an edge that leaves the neighbourhood', () => {
      const out = toMermaid(g, { focus: 'Task' })
      expect(out).toContain('Task <|-- RecurringTask')
      expect(out).toContain('Task --> Project : project')
      // RecurringTask -> Priority leaves the focused set, so neither the edge nor Priority appears.
      expect(out).not.toContain('Priority')
    })

    it('shows only expectations touching a visible term, and only their in-view edges', () => {
      const out = toMermaid(g, {
        focus: 'Task',
        expectations: [
          expectation({ id: 'e-1', terms: ['Task'] }),
          expectation({ id: 'e-2', terms: ['Unrelated'] }),
          expectation({ id: 'e-3', terms: ['Task', 'Priority'] }),
        ],
      })
      expect(out).toContain('e_1 ..> Task')
      expect(out).not.toContain('e_2') // touches nothing visible
      expect(out).toContain('e_3 ..> Task')
      expect(out).not.toContain('e_3 ..> Priority') // Priority is out of view
    })

    it('falls back to the whole graph when focus names a term not in the glossary', () => {
      const out = toMermaid(g, { focus: 'Nope' })
      expect(out).toContain('class Task {')
      expect(out).toContain('class Unrelated {')
    })
  })

  it('is deterministic: terms are ordered by name regardless of input order', () => {
    const a = toMermaid([term({ name: 'Zeta' }), term({ name: 'Alpha' })])
    const b = toMermaid([term({ name: 'Alpha' }), term({ name: 'Zeta' })])
    expect(a).toBe(b)
    expect(a.indexOf('class Alpha')).toBeLessThan(a.indexOf('class Zeta'))
  })
})
