import { describe, expect, it } from 'vitest'
import { computeCoverage } from './coverage.js'
import type { Expectation, Term } from './types.js'

function term(name: string, type: Term['type'], extra: Partial<Term> = {}): Term {
  return { name, type, spec: '', parent: null, tags: [], attributes: [], ...extra }
}

function expectation(id: string, terms: string[], extra: Partial<Expectation> = {}): Expectation {
  return {
    id,
    kind: 'functional',
    terms,
    given: '',
    expect: 'something holds',
    raisedBy: { pass: 'test' },
    supersededBy: null,
    contested: [],
    ...extra,
  }
}

/**
 * The glossary this repo actually has, trimmed to the shape q-004 came out of:
 * a Task belongs to a Project, a RecurringTask is a Task, and deleteProject takes a Project.
 */
const GLOSSARY: Term[] = [
  term('Project', 'entity'),
  term('Task', 'entity', { attributes: [{ name: 'project', valueType: 'ref:Project' }] }),
  term('RecurringTask', 'entity', { parent: 'Task' }),
  term('completeTask', 'function', { attributes: [{ name: 'target', valueType: 'ref:Task' }] }),
  term('deleteProject', 'function', { attributes: [{ name: 'target', valueType: 'ref:Project' }] }),
]

describe('pair coverage', () => {
  it('pairs an action with the entity it names, at distance 1', () => {
    const { entities } = computeCoverage(GLOSSARY, [])
    const project = entities.find((entry) => entry.entity === 'Project')!

    expect(project.pairs).toContainEqual(
      expect.objectContaining({ entity: 'Project', action: 'deleteProject', distance: 1 }),
    )
  })

  it('gives subtypes the same distance as their supertype, since a RecurringTask is a Task', () => {
    const { entities } = computeCoverage(GLOSSARY, [])
    const recurring = entities.find((entry) => entry.entity === 'RecurringTask')!

    expect(recurring.pairs).toContainEqual(
      expect.objectContaining({ action: 'completeTask', distance: 1 }),
    )
  })

  /** The one this exists for. Nothing in either file mentions the other. */
  it('finds deleteProject x RecurringTask, two hops out and one of them backwards', () => {
    const { gaps } = computeCoverage(GLOSSARY, [])

    expect(gaps).toContainEqual(
      expect.objectContaining({ entity: 'RecurringTask', action: 'deleteProject', distance: 2 }),
    )
  })

  it('does not reach it at distance 1', () => {
    const { entities } = computeCoverage(GLOSSARY, [], { maxDistance: 1 })
    const recurring = entities.find((entry) => entry.entity === 'RecurringTask')!

    expect(recurring.pairs.map((pair) => pair.action)).not.toContain('deleteProject')
  })

  it('counts a pair covered only when an expectation names both ends', () => {
    const oneEnd = computeCoverage(GLOSSARY, [expectation('e-001', ['deleteProject'])])
    const bothEnds = computeCoverage(GLOSSARY, [expectation('e-002', ['deleteProject', 'RecurringTask'])])

    const gapFor = (report: ReturnType<typeof computeCoverage>) =>
      report.gaps.find((pair) => pair.entity === 'RecurringTask' && pair.action === 'deleteProject')

    expect(gapFor(oneEnd), 'naming one end is not thinking about the interaction').toBeDefined()
    expect(gapFor(bothEnds)).toBeUndefined()
  })

  it('stops counting an expectation once it is superseded', () => {
    const live = expectation('e-002', ['deleteProject', 'RecurringTask'])
    const retired = { ...live, supersededBy: 'e-003' }

    expect(computeCoverage(GLOSSARY, [live]).gaps).not.toContainEqual(
      expect.objectContaining({ entity: 'RecurringTask', action: 'deleteProject' }),
    )
    expect(computeCoverage(GLOSSARY, [retired]).gaps).toContainEqual(
      expect.objectContaining({ entity: 'RecurringTask', action: 'deleteProject' }),
    )
  })

  /**
   * The rule that answers "how does anyone know it clashes?" — the pair stays a gap, and the
   * disagreement is reported where it reads as work rather than as coverage. Counting it would
   * mark the pair thought-through at the exact moment it is most in dispute.
   */
  it('does not let a contradicted expectation cover its pair', () => {
    const contested = expectation('e-011', ['deleteProject', 'RecurringTask'], {
      contested: [
        {
          kind: 'contradicts',
          subject: 'deleteProject',
          detail: 'the spec says the opposite',
          quote: 'Blocks rather than cascades.',
        },
      ],
    })
    const report = computeCoverage(GLOSSARY, [contested])

    expect(report.gaps).toContainEqual(
      expect.objectContaining({ entity: 'RecurringTask', action: 'deleteProject' }),
    )
    expect(report.contested).toEqual([
      { expectation: 'e-011', subject: 'deleteProject', quote: 'Blocks rather than cascades.' },
    ])
  })

  it('still counts one whose only clash is a duplicate — that is noise, not disagreement', () => {
    const noisy = expectation('e-012', ['deleteProject', 'RecurringTask'], {
      contested: [{ kind: 'duplicate', subject: 'e-002', detail: 'says something similar' }],
    })

    expect(computeCoverage(GLOSSARY, [noisy]).gaps).not.toContainEqual(
      expect.objectContaining({ entity: 'RecurringTask', action: 'deleteProject' }),
    )
  })

  it('lists non-functional expectations without matching them to pairs', () => {
    const report = computeCoverage(GLOSSARY, [
      expectation('e-010', ['Task'], { kind: 'non-functional', expect: 'the list stays responsive' }),
    ])

    expect(report.nonFunctional).toEqual(['e-010'])
    expect(report.entities.flatMap((entry) => entry.pairs).flatMap((pair) => pair.expectations)).toEqual([])
  })

  it('lists invariants separately, and never counts them as pair coverage', () => {
    const report = computeCoverage(GLOSSARY, [
      expectation('e-020', ['Task', 'deleteProject'], { kind: 'invariant', expect: 'a Task always belongs to exactly one Project' }),
    ])

    expect(report.invariants).toEqual(['e-020'])
    expect(report.nonFunctional).toEqual([])
    // Even though it names an (entity, action) pair, an invariant is a property, not pair coverage.
    expect(report.entities.flatMap((entry) => entry.pairs).flatMap((pair) => pair.expectations)).toEqual([])
  })

  it('reports an expectation naming a term the glossary does not have', () => {
    const report = computeCoverage(GLOSSARY, [expectation('e-011', ['Task', 'Sprint'])])
    expect(report.dangling).toEqual([{ expectation: 'e-011', term: 'Sprint' }])
  })

  it('does not walk through attribute-types, which would connect everything to everything', () => {
    const withValueShape: Term[] = [
      ...GLOSSARY,
      term('Priority', 'attribute-type'),
      term('Label', 'entity', { attributes: [{ name: 'priority', valueType: 'ref:Priority' }] }),
    ]
    const priorityCarrying = [
      ...withValueShape.filter((entry) => entry.name !== 'Task'),
      term('Task', 'entity', {
        attributes: [
          { name: 'project', valueType: 'ref:Project' },
          { name: 'priority', valueType: 'ref:Priority' },
        ],
      }),
    ]

    const { entities } = computeCoverage(priorityCarrying, [])
    const label = entities.find((entry) => entry.entity === 'Label')!

    expect(label.pairs, 'Label shares only a value shape with Task, which is not a relationship').toEqual([])
  })

  it('sorts gaps nearest first, so the work list is in the order worth working it', () => {
    const { gaps } = computeCoverage(GLOSSARY, [])
    const distances = gaps.map((pair) => pair.distance)
    expect(distances).toEqual([...distances].sort((left, right) => left - right))
  })
})
