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
 */
import { useEffect, useMemo, useState } from 'react'
import type { Expectation, Term } from '@abseed/spectra-core'
import { toMermaid } from '@abseed/spectra-core'
import mermaid from 'mermaid'

let initialized = false
function ensureInitialized(): void {
  if (initialized) return
  // securityLevel 'strict' sanitizes the output; we render no click handlers, so nothing needs to run.
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
  initialized = true
}

// A unique id per render call — Mermaid uses it for the SVG's internal element ids.
let renderSeq = 0

export function Diagram({ terms, expectations }: { terms: Term[]; expectations: Expectation[] }) {
  const code = useMemo(() => toMermaid(terms, { expectations }), [terms, expectations])
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  if (terms.length === 0) return <p className="muted empty">No terms to diagram yet.</p>
  if (error) {
    return (
      <div className="diagram-error">
        <p className="error">Could not render the diagram: {error}</p>
        <pre>{code}</pre>
      </div>
    )
  }
  if (!svg) return <p className="muted empty">Rendering diagram…</p>
  // The SVG is Mermaid's own sanitized output (securityLevel 'strict'), not user HTML.
  return <div className="diagram" style={{ overflow: 'auto', padding: '1rem' }} dangerouslySetInnerHTML={{ __html: svg }} />
}
