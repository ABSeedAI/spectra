/**
 * The System Brief (GH #143): free-prose product framing that sits *above* the domain glossary —
 * what is being built (engine / API / app + UI), for whom, and how it is used. It is the single
 * biggest input to what @coder builds, and it is injected into both agents' prompt, so it belongs
 * in front of the human too: a small, editable panel, not buried in settings.
 *
 * Human-authored in v1 (agents proposing edits is a later slice). Rendered read-only until the human
 * opens the editor, so it reads as reference most of the time. Absent `onSave` (a host/transport that
 * cannot write it) makes it view-only.
 */
import { useState } from 'react'

interface SystemBriefProps {
  brief?: string
  onSave?: (brief: string) => void
  busy: boolean
}

export function SystemBrief({ brief, onSave, busy }: SystemBriefProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // Nothing to show and no way to add one — stay out of the way entirely.
  if (!brief && !onSave) return null

  function open() {
    setDraft(brief ?? '')
    setEditing(true)
  }

  function save() {
    onSave?.(draft)
    setEditing(false)
  }

  return (
    <section className="system-brief">
      <h2>
        System Brief
        {onSave && !editing && (
          <button type="button" className="action" onClick={open} disabled={busy}>
            {brief ? 'edit' : 'add'}
          </button>
        )}
      </h2>

      {editing ? (
        <div className="brief-edit">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What's being built, for whom, and how it's used — e.g. “An HTTP API for gamification; developers integrate it; no UI of its own.” Keep it to shape, audience, usage and boundaries — tech decisions belong in ADRs."
            rows={5}
          />
          <div className="brief-actions">
            <span className="muted">Framing for both agents — it's injected into every turn.</span>
            <span>
              <button type="button" className="action" onClick={() => setEditing(false)} disabled={busy}>
                cancel
              </button>
              <button type="button" className="action action-answer" onClick={save} disabled={busy}>
                Save
              </button>
            </span>
          </div>
        </div>
      ) : brief ? (
        <p className="brief-body">{brief}</p>
      ) : (
        <p className="muted empty">
          No brief yet — say what's being built (engine / API / app), for whom, and how it's used. It
          steers what @coder produces.
        </p>
      )}
    </section>
  )
}
