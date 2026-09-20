import type { Scenario } from '@abseed/spectra-core'
import { TermRef } from './TermRef.js'

interface ScenarioPanelProps {
  scenarios: Scenario[]
  /** Term names the glossary actually declares — an undeclared one renders as broken, not a link. */
  known: Set<string>
  onSelectTerm: (name: string) => void
}

/**
 * The stored scenarios — cross-entity, spec-level test cases. Read-only for now: a concrete situation
 * (setup + steps + assertions) that walks several terms together. Where an Expectation is a single
 * entity-level rule, a Scenario is the combination worth remembering — so it earns its own list rather
 * than hiding among the per-term expectations.
 */
export function ScenarioPanel({ scenarios, known, onSelectTerm }: ScenarioPanelProps) {
  if (scenarios.length === 0) return null

  return (
    <section className="scenarios">
      <h2>Scenarios</h2>
      {scenarios.map((scenario) => (
        <article key={scenario.id} className="scenario-card">
          <h3>
            <span className="scenario-id">{scenario.id}</span>
            {scenario.title}
          </h3>
          <div className="scenario-terms">
            {scenario.terms.map((term) => (
              <TermRef key={term} name={term} known={known} onSelect={onSelectTerm} />
            ))}
          </div>
          {scenario.given ? <p className="scenario-given">Given {scenario.given}</p> : null}
          {scenario.steps.length > 0 ? (
            <>
              <div className="scenario-label">Steps</div>
              <ol>
                {scenario.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </>
          ) : null}
          <div className="scenario-label">Expect</div>
          <ul>
            {scenario.expect.map((assertion, index) => (
              <li key={index}>{assertion}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  )
}
