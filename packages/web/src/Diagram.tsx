/**
 * The glossary as a rendered Mermaid class diagram. The string comes from core's `toMermaid` (the
 * single, tested projection — see mermaid.ts); this component only turns it into SVG and shows it.
 *
 * Why it lives in the app and not `web-lib`: rendering pulls in Mermaid (a heavy dependency with its
 * own d3/dagre stack), and `web-lib` is deliberately dependency-light (core + React only) so any host
 * can compose it. A host that wants the diagram imports the pure `toMermaid` from core and renders it
 * however it likes — this file is the local tool's way of doing that.
 *
 * Mermaid renders asynchronously and throws on a bad graph, so we render into state, guard against a
 * stale async result on rapid re-renders, and fall back to showing the source (plus the error) rather
 * than blanking the view.
 *
 * Selecting a node: when `onSelectTerm` is given, we make each term node clickable so the host can open
 * that term's detail panel — the same selection the list drives. We keep `securityLevel: 'strict'`
 * (Mermaid's own `click` directives are stripped at that level) and instead bind our OWN listeners to
 * the rendered class nodes after injecting the SVG, mapping a node back to its term by its visible
 * label (which `toMermaid` guarantees is the real term name, even when the safe class id differs).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Expectation, Term } from '@abseed/spectra-core'
import { toMermaid } from '@abseed/spectra-core'
import mermaid from 'mermaid'

let initialized = false
function ensureInitialized(): void {
  if (initialized) return
  // securityLevel 'strict' sanitizes the SVG; we bind selection listeners ourselves (see file header),
  // so no Mermaid click directive — nothing untrusted runs.
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
  initialized = true
}

// A unique id per render call — Mermaid uses it for the SVG's internal element ids.
let renderSeq = 0

/**
 * The term a rendered class node stands for, or null if it isn't a term node (an expectation node, a
 * `<<missing>>` stub, or a decoration). Matches the node's visible label against the known term names:
 * `toMermaid` labels a class with the real term name, so this survives the safe-id remapping and does
 * not depend on Mermaid's internal id scheme. Tries the class-title element first, then any text line.
 */
function nodeTermName(node: Element, names: Set<string>): string | null {
  const title = node.querySelector('.classTitle, .nodeLabel')?.textContent?.trim()
  if (title && names.has(title)) return title
  for (const text of node.querySelectorAll('text, span, tspan')) {
    const value = text.textContent?.trim()
    if (value && names.has(value)) return value
  }
  return null
}

export function Diagram({
  terms,
  expectations,
  onSelectTerm,
}: {
  terms: Term[]
  expectations: Expectation[]
  /** Called with a term name when its node is clicked; omit to render a non-interactive diagram. */
  onSelectTerm?: (name: string) => void
}) {
  // Focus is the scale lever: a large glossary is unreadable whole, so pick a term and see only its
  // one-hop neighbourhood. '' means "all terms". Reset the choice if the focused term disappears.
  const [focus, setFocus] = useState('')
  const [showExpectations, setShowExpectations] = useState(true)
  const names = useMemo(() => terms.map((term) => term.name).sort((a, b) => a.localeCompare(b)), [terms])
  useEffect(() => {
    if (focus && !names.includes(focus)) setFocus('')
  }, [names, focus])

  const code = useMemo(
    () => toMermaid(terms, { expectations: showExpectations ? expectations : [], focus: focus || undefined }),
    [terms, expectations, focus, showExpectations],
  )
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (terms.length === 0) {
      setSvg(null)
      setError(null)
      return
    }
    let cancelled = false
    ensureInitialized()
    mermaid.render(`spectra-diagram-${renderSeq++}`, code).then(
      (result) => {
        if (!cancelled) {
          setSvg(result.svg)
          setError(null)
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setSvg(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [code, terms.length])

  // Make term nodes clickable once the SVG is in the DOM. Re-binds on every re-render (the nodes are
  // fresh each time) and cleans up its listeners, so a rapid re-render or StrictMode's double-invoke
  // never leaves a node double-bound. A no-op without `onSelectTerm`.
  useEffect(() => {
    const container = containerRef.current
    if (!svg || !container || !onSelectTerm) return
    const names = new Set(terms.map((term) => term.name))
    const cleanups: Array<() => void> = []
    for (const node of container.querySelectorAll<SVGGElement>('g.node, g.classGroup')) {
      const name = nodeTermName(node, names)
      if (!name) continue // expectation node, <<missing>> stub, or decoration — leave inert
      node.style.cursor = 'pointer'
      const onClick = (): void => onSelectTerm(name)
      node.addEventListener('click', onClick)
      cleanups.push(() => {
        node.removeEventListener('click', onClick)
        node.style.cursor = ''
      })
    }
    return () => cleanups.forEach((fn) => fn())
  }, [svg, terms, onSelectTerm])

  if (terms.length === 0) return <p className="muted empty">No terms to diagram yet.</p>

  const controls = (
    <div className="diagram-controls" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.5rem 1rem' }}>
      <label htmlFor="diagram-focus" className="muted">
        Focus
      </label>
      <select id="diagram-focus" value={focus} onChange={(event) => setFocus(event.target.value)}>
        <option value="">All terms</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {focus && <span className="muted">— {focus} and everything connected to it</span>}
      {expectations.length > 0 && (
        <label style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={showExpectations}
            onChange={(event) => setShowExpectations(event.target.checked)}
          />
          Expectations
        </label>
      )}
    </div>
  )

  const body = error ? (
    <div className="diagram-error" style={{ padding: '1rem' }}>
      <p className="error">Could not render the diagram: {error}</p>
      <pre>{code}</pre>
    </div>
  ) : !svg ? (
    <p className="muted empty">Rendering diagram…</p>
  ) : (
    // The SVG is Mermaid's own sanitized output (securityLevel 'strict'), not user HTML.
    <div ref={containerRef} className="diagram" style={{ overflow: 'auto', padding: '1rem' }} dangerouslySetInnerHTML={{ __html: svg }} />
  )

  return (
    <div className="diagram-wrap">
      {controls}
      {body}
    </div>
  )
}
