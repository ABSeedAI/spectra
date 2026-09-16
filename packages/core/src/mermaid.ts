/**
 * A Mermaid `classDiagram` view of the glossary — a read-only projection, never written back and
 * never part of the versioned contract. It exists so the vocabulary can be *seen* as the graph it
 * already is: terms are nodes, and the edges are exactly what `computeBacklinks` derives from
 * `parent` and `ref:` attribute types. Reusing that keeps the diagram honest — it can never disagree
 * with the backlinks the rest of the UI draws, because it is the same computation.
 *
 * Choices that make the picture read well and the output stable:
 * - **classDiagram**, because a Term with attributes maps onto a class with members, `parent` onto
 *   generalization, and a `ref:` attribute onto an association — the shape people already expect.
 * - **Primitive attributes become members; `ref:` attributes become edges** (labelled by the
 *   attribute, `"*"` multiplicity for arrays), not both — showing a reference as a member *and* an
 *   arrow doubles the noise. `default`/`optional` are omitted for v1 to keep member lines parser-safe.
 * - **A referenced-but-missing term gets a `<<missing>>` stub** so a dangling ref is visible rather
 *   than surfacing as an unlabelled node Mermaid invents on its own.
 * - **Expectations, when supplied, are drawn as their own nodes** (stereotyped by kind, labelled by
 *   id) with a dashed dependency arrow to each term they concern — matching the way the schema treats
 *   an Expectation as first-class, referencing the vocabulary rather than being part of it. Retired
 *   (superseded) expectations are left out. This is where the picture can get busy on a large
 *   glossary; filtering/focus is a deliberate later concern (a host can pre-filter the inputs).
 * - **Deterministic**: terms sorted by name, expectations by id, attributes/edges in declared order.
 *   Re-rendering an unchanged glossary yields byte-identical output — safe to cache, diff, snapshot.
 */
import type { Expectation, Term, TermType } from './types.js'
import { computeBacklinks } from './backlinks.js'
import { parseValueType } from './valueType.js'

const STEREOTYPE: Record<TermType, string> = {
  entity: 'entity',
  event: 'event',
  function: 'function',
  'attribute-type': 'attribute-type',
}

export interface ToMermaidOptions {
  /** Layout direction, passed straight to Mermaid. Default 'LR' — wide graphs read better than tall. */
  direction?: 'LR' | 'TB' | 'RL' | 'BT'
  /**
   * Expectations to overlay. Each becomes a node linked by a dashed dependency to the terms it
   * concerns. Retired (superseded) ones are dropped. Omit to draw the term graph alone.
   */
  expectations?: Expectation[]
}

/**
 * Mermaid class ids must be identifier-like and unique. Term names usually already are (the `ref:`
 * grammar only accepts identifiers as targets), but a name is not guaranteed to be, so map every
 * name to a safe, collision-free id; the real name rides along as the class label when they differ.
 */
function safeIds(names: string[]): Map<string, string> {
  const ids = new Map<string, string>()
  const used = new Set<string>()
  for (const name of names) {
    if (ids.has(name)) continue
    let base = name.replace(/[^A-Za-z0-9_]/g, '_')
    if (base === '' || /^[0-9]/.test(base)) base = `t_${base}`
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`
    used.add(id)
    ids.set(name, id)
  }
  return ids
}

export function toMermaid(terms: Term[], options: ToMermaidOptions = {}): string {
  const direction = options.direction ?? 'LR'
  const sorted = [...terms].sort((a, b) => a.name.localeCompare(b.name))
  const backlinks = computeBacklinks(terms)

  // Live expectations only (a retired one is history, not part of the picture), sorted by id.
  const expectations = (options.expectations ?? [])
    .filter((expectation) => expectation.supersededBy == null)
    .sort((a, b) => a.id.localeCompare(b.id))

  // Every declared term, plus any referenced-but-missing target so its edge has a node to land on —
  // from term parent/attribute refs (backlinks) and from expectations that name an unknown term.
  const known = new Set(terms.map((term) => term.name))
  const missing = [
    ...new Set([
      ...backlinks.dangling.map((ref) => ref.to),
      ...expectations.flatMap((expectation) => expectation.terms).filter((name) => !known.has(name)),
    ]),
  ].sort((a, b) => a.localeCompare(b))
  const ids = safeIds([...sorted.map((term) => term.name), ...missing, ...expectations.map((expectation) => expectation.id)])
  const id = (name: string): string => ids.get(name) ?? name
  const decl = (name: string): string => {
    const i = id(name)
    return i === name ? `class ${i}` : `class ${i}["${name}"]`
  }

  const lines: string[] = ['classDiagram', `  direction ${direction}`]

  for (const term of sorted) {
    lines.push(`  ${decl(term.name)} {`)
    lines.push(`    <<${STEREOTYPE[term.type]}>>`)
    // Primitives become members; ref attributes are drawn as edges below, not duplicated here.
    for (const attribute of term.attributes) {
      const parsed = parseValueType(attribute.valueType)
      if (parsed?.kind === 'primitive') {
        lines.push(`    +${attribute.name} ${parsed.name}${parsed.array ? '[]' : ''}`)
      }
    }
    lines.push('  }')
  }

  // Missing targets get a flagged stub so a dangling reference is legible.
  for (const name of missing) {
    lines.push(`  ${decl(name)} {`)
    lines.push('    <<missing>>')
    lines.push('  }')
  }

  // Expectations as their own nodes, stereotyped by kind. Text (given/expect) stays out of the node
  // to keep the line parser-safe — the id is the addressable handle, and the full statement lives in
  // the expectation panel a click away.
  for (const expectation of expectations) {
    lines.push(`  ${decl(expectation.id)} {`)
    lines.push(`    <<${expectation.kind}>>`)
    lines.push('  }')
  }

  // Edges: parent → generalization (Parent <|-- Child); ref attribute → association labelled by the
  // attribute, with a "*" multiplicity for arrays. bySource lists parent first then attributes in
  // order, and terms are sorted, so the edge order is deterministic.
  for (const term of sorted) {
    for (const ref of backlinks.bySource[term.name] ?? []) {
      if (ref.kind === 'parent') {
        lines.push(`  ${id(ref.to)} <|-- ${id(ref.from)}`)
      } else {
        const multiplicity = ref.array ? ' "*"' : ''
        lines.push(`  ${id(ref.from)} -->${multiplicity} ${id(ref.to)} : ${ref.via}`)
      }
    }
  }

  // Expectation → term as a dashed dependency ("concerns"), distinct from associations and is-a
  // edges. A non-functional expectation with no terms is a floating node (an app-wide statement).
  for (const expectation of expectations) {
    for (const name of expectation.terms) {
      lines.push(`  ${id(expectation.id)} ..> ${id(name)}`)
    }
  }

  return lines.join('\n')
}
