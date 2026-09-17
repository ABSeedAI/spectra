/**
 * Coverage, meaning "did we think about this thing's lifecycle" — not "is it correct".
 *
 * Nothing here judges an implementation. A term with five expectations is a term someone
 * thought about five times, which is not the same as a term that works. What this answers is
 * narrower and more useful: we named `RecurringTask` and gave it attributes, but did anyone
 * ever say what should happen when a Project holding one is deleted? That question has a
 * yes-or-no answer computable from the glossary, and an empty answer is a real gap whether or
 * not the code happens to do the right thing.
 *
 * The unit is therefore the **pair**, not the term. Counting expectations per term would have
 * called `RecurringTask` covered from the day q-002 landed — it had expectations about
 * completion — while the hole sat in its interaction with deletion. q-004 is exactly that
 * hole, and it took a second implementation pass to find:
 *
 *     deleteProject --ref:Project--> Project <--Task.project-- Task <--parent-- RecurringTask
 *
 * Two hops, one of them traversed backwards, plus a subtype step. Nobody sees that by reading
 * a file, which is the entire argument for computing it.
 *
 * Distance is reported rather than filtered on, because it sorts the work. Pairs at distance 1
 * are usually already covered by the prose — the function's own spec names the entity it
 * takes. The ones at 2 and beyond are where the questions come from.
 */
import type { Expectation, Term } from './types.js'
import { computeBacklinks } from './backlinks.js'
import type { Backlinks } from './backlinks.js'

/** Terms that *do* something — the lifecycle side of a pair. */
const ACTION_TYPES = new Set(['function', 'event'])

/**
 * Terms a lifecycle happens *to*. `attribute-type` is deliberately absent: Priority and
 * RecurrenceRule are value shapes carried by other terms, not things with a life of their own,
 * and walking through them would connect everything to everything.
 */
const SUBJECT_TYPES = new Set(['entity'])

export interface CoveragePair {
  entity: string
  action: string
  /** 1 when the action names the entity directly; 2+ when reached through the entity graph. */
  distance: number
  /** Ids of live expectations naming both ends. */
  expectations: string[]
}

export interface EntityCoverage {
  entity: string
  pairs: CoveragePair[]
  covered: number
  uncovered: number
}

export interface Coverage {
  entities: EntityCoverage[]
  /** Every uncovered pair, nearest first. The work list, in the order worth working it. */
  gaps: CoveragePair[]
  /**
   * Non-functional expectations, listed and never matched. They are properties of a build
   * rather than of the vocabulary, so they have no pair to land on — counting them here keeps
   * them visible without letting them inflate a number that means something else.
   */
  nonFunctional: string[]
  /**
   * Invariants — domain properties that must always hold. Like non-functional ones they have no
   * (entity, action) pair to land on (they constrain state across the vocabulary, not one behaviour),
   * so they are listed here rather than counted into the pair-coverage number, but they are first-class
   * and reference real terms. Surfaced so the board shows the rules that guard the whole model.
   */
  invariants: string[]
  /**
   * Expectations that disagree with a term's spec, and what they disagree with.
   *
   * These cover nothing and are not gaps either — they are decisions nobody has made. Whoever
   * reads this has to settle which side gives before the pair can be covered at all.
   */
  contested: Array<{ expectation: string; subject: string; quote?: string }>
  /** Expectations naming a term the glossary does not have — renamed, or a typo. */
  dangling: Array<{ expectation: string; term: string }>
}

export interface CoverageOptions {
  /**
   * How far from an action to look for entities it touches. Two reaches the q-004 shape and
   * keeps the pair list readable; three connects most glossaries to themselves.
   */
  maxDistance?: number
}

/** A term and every term that inherits from it, transitively. */
function withSubtypes(backlinks: Backlinks, name: string): string[] {
  const found = new Set<string>()
  const queue = [name]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (found.has(current)) continue
    found.add(current)
    queue.push(...(backlinks.children[current] ?? []))
  }

  return [...found]
}

/**
 * Which entities each action touches, and how far away they are.
 *
 * Subtypes come free — they sit at the same distance as their supertype rather than one hop
 * further, because a RecurringTask *is* a Task. Anything that touches Task touches every
 * RecurringTask by definition, and charging a hop for that would push the most interesting
 * pairs out past the limit.
 *
 * Supertypes are deliberately not walked. An action naming `RecurringTask` outright has said
 * what it means; adding `Task` back would list a pair nobody asked about.
 */
function reachFrom(terms: Term[], backlinks: Backlinks, action: Term, maxDistance: number): Map<string, number> {
  const byName = new Map(terms.map((term) => [term.name, term]))
  const isSubject = (name: string) => SUBJECT_TYPES.has(byName.get(name)?.type ?? '')

  const distances = new Map<string, number>()

  const admit = (name: string, distance: number) => {
    if (!isSubject(name)) return
    for (const subtype of withSubtypes(backlinks, name)) {
      const known = distances.get(subtype)
      if (known === undefined || known > distance) distances.set(subtype, distance)
    }
  }

  for (const reference of backlinks.bySource[action.name] ?? []) {
    if (reference.kind === 'attribute') admit(reference.to, 1)
  }

  for (let distance = 2; distance <= maxDistance; distance += 1) {
    for (const [name, known] of [...distances]) {
      if (known !== distance - 1) continue

      // Undirected on purpose. `Task.project: ref:Project` is the only edge between those two
      // terms, and it points the wrong way for the question being asked — deleteProject
      // reaches Project, and Project's Tasks are what block it.
      for (const reference of backlinks.bySource[name] ?? []) {
        if (reference.kind === 'attribute') admit(reference.to, distance)
      }
      for (const reference of backlinks.byTarget[name] ?? []) {
        if (reference.kind === 'attribute') admit(reference.from, distance)
      }
    }
  }

  return distances
}

/**
 * An expectation covers a pair when it names *both* ends.
 *
 * Deliberately strict. Loosening it to "names either" would mark
 * `deleteProject × RecurringTask` covered on the strength of an expectation about deleting an
 * empty Project, which is the exact blindness this exists to remove. The cost is that the
 * board starts almost entirely empty, including for pairs the prose already handles — that is
 * the honest starting position, not a defect in the measure.
 */
export function computeCoverage(
  terms: Term[],
  expectations: Expectation[],
  options: CoverageOptions = {},
): Coverage {
  const maxDistance = options.maxDistance ?? 2
  const backlinks = computeBacklinks(terms)
  const known = new Set(terms.map((term) => term.name))

  // Retired expectations are history: they record what was once expected and must not keep a
  // pair looking covered after the statement that covered it was withdrawn.
  const live = expectations.filter((expectation) => expectation.supersededBy === null)

  /**
   * An expectation that contradicts a spec covers nothing, and this is the load-bearing line.
   *
   * Coverage means somebody has said what should happen *and the glossary agrees*. A
   * contradicted expectation is not a settled answer wearing an expectation's clothes — it is
   * an open disagreement, and counting it would mark the pair as thought-through at the exact
   * moment it is most in dispute. So the pair stays a gap, and the disagreement shows up
   * separately in `contested`, where it reads as work rather than as coverage.
   */
  const contested = live.filter((expectation) =>
    expectation.contested.some((clash) => clash.kind === 'contradicts'),
  )
  const contestedIds = new Set(contested.map((expectation) => expectation.id))

  const functional = live.filter(
    (expectation) => expectation.kind === 'functional' && !contestedIds.has(expectation.id),
  )

  const actions = terms.filter((term) => ACTION_TYPES.has(term.type))
  const entities = new Map<string, CoveragePair[]>(
    terms.filter((term) => SUBJECT_TYPES.has(term.type)).map((term) => [term.name, []]),
  )

  for (const action of actions) {
    for (const [entity, distance] of reachFrom(terms, backlinks, action, maxDistance)) {
      const pairs = entities.get(entity)
      if (!pairs) continue

      pairs.push({
        entity,
        action: action.name,
        distance,
        expectations: functional
          .filter((expectation) => expectation.terms.includes(entity) && expectation.terms.includes(action.name))
          .map((expectation) => expectation.id),
      })
    }
  }

  const summaries: EntityCoverage[] = [...entities]
    .map(([entity, pairs]) => {
      pairs.sort((left, right) => left.distance - right.distance || left.action.localeCompare(right.action))
      return {
        entity,
        pairs,
        covered: pairs.filter((pair) => pair.expectations.length > 0).length,
        uncovered: pairs.filter((pair) => pair.expectations.length === 0).length,
      }
    })
    .sort((left, right) => left.entity.localeCompare(right.entity))

  return {
    entities: summaries,
    gaps: summaries
      .flatMap((summary) => summary.pairs)
      .filter((pair) => pair.expectations.length === 0)
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          left.entity.localeCompare(right.entity) ||
          left.action.localeCompare(right.action),
      ),
    nonFunctional: live
      .filter((expectation) => expectation.kind === 'non-functional')
      .map((expectation) => expectation.id),
    invariants: live
      .filter((expectation) => expectation.kind === 'invariant')
      .map((expectation) => expectation.id),
    contested: contested.flatMap((expectation) =>
      expectation.contested
        .filter((clash) => clash.kind === 'contradicts')
        .map((clash) => ({
          expectation: expectation.id,
          subject: clash.subject,
          ...(clash.quote ? { quote: clash.quote } : {}),
        })),
    ),
    dangling: live.flatMap((expectation) =>
      expectation.terms
        .filter((term) => !known.has(term))
        .map((term) => ({ expectation: expectation.id, term })),
    ),
  }
}
