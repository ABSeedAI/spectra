import { useState } from 'react'
import type { Question, QuestionOption } from '@abseed/spectra-core'
import { summarizeOp } from '@abseed/spectra-core'
import { FilterPills, toggled } from './FilterPills.js'
import { TermRef } from './TermRef.js'

interface QuestionPanelProps {
  questions: Question[]
  known: Set<string>
  onSelectTerm: (name: string) => void
  onAnswer: (id: string, chose: string | null, note: string) => void
  /** Human override of @coder's blocking flag (GH #137). Omitted when the host doesn't wire it. */
  onSetBlocking?: (id: string, blocking: boolean) => void
  busy: boolean
}

/**
 * Decided questions stay available but not on screen. They are the record of why the
 * glossary says what it says, and worth keeping forever — which is exactly why they should
 * not compete for space with the ones still waiting on you.
 */
const DEFAULT_FILTERS = new Set(['unanswered'])

/**
 * The questions an implementation pass raised against the glossary. Open ones sit at the
 * top because an unanswered question is a decision nobody has made yet; answered ones are
 * a click away behind the "decided" pill.
 */
export function QuestionPanel({ questions, known, onSelectTerm, onAnswer, onSetBlocking, busy }: QuestionPanelProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [filters, setFilters] = useState<ReadonlySet<string>>(DEFAULT_FILTERS)

  if (questions.length === 0) return null

  // Blocking-and-open floats to the top: @coder said it can't finish without this (GH #137).
  // Blocking is effective only while open, so answered questions never sort by it.
  const open = questions
    .filter((question) => !question.answer)
    .sort((a, b) => (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0))
  const answered = questions.filter((question) => question.answer)

  const shown = [
    ...(filters.has('unanswered') ? open : []),
    ...(filters.has('decided') ? answered : []),
  ]

  return (
    <section className="questions">
      <h2>
        Questions
        <FilterPills
          active={filters}
          onToggle={(key) => setFilters((current) => toggled(current, key))}
          options={[
            { key: 'unanswered', label: 'unanswered', count: open.length, tone: 'open' },
            { key: 'decided', label: 'decided', count: answered.length },
          ]}
        />
      </h2>

      {shown.length === 0 && (
        <p className="muted empty-filter">
          {open.length === 0 ? 'Nothing unanswered.' : 'Everything is filtered out.'}
        </p>
      )}

      {shown.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          expanded={openId === question.id}
          onToggle={() => setOpenId(openId === question.id ? null : question.id)}
          known={known}
          onSelectTerm={onSelectTerm}
          onAnswer={onAnswer}
          onSetBlocking={onSetBlocking}
          busy={busy}
        />
      ))}
    </section>
  )
}

function QuestionCard({
  question,
  expanded,
  onToggle,
  known,
  onSelectTerm,
  onAnswer,
  onSetBlocking,
  busy,
}: {
  question: Question
  expanded: boolean
  onToggle: () => void
  known: Set<string>
  onSelectTerm: (name: string) => void
  onAnswer: (id: string, chose: string | null, note: string) => void
  onSetBlocking?: (id: string, blocking: boolean) => void
  busy: boolean
}) {
  const [chose, setChose] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const answer = question.answer
  const decided = answer !== null
  // Blocking is effective only while open; an answered question blocks nothing.
  const blocking = !decided && question.blocking === true

  // The number of options *is* the answer shape — one is approve-or-decline, several is a
  // choice, none means only the human can write the spec text.
  const shape =
    question.options.length === 0
      ? 'needs your words'
      : question.options.length === 1
        ? 'approve or decline'
        : `${question.options.length} ways to go`

  return (
    <article className={`question ${decided ? 'decided' : 'open'} ${blocking ? 'blocking' : ''}`}>
      <button type="button" className="question-head" onClick={onToggle}>
        <span className="question-id">{question.id}</span>
        {blocking && <span className="pill pill-blocking" title="@coder can't finish without this answer">blocking</span>}
        <span className="asks">{question.asks}</span>
        <span className={`pill ${decided ? '' : 'pill-open'}`}>
          {decided ? answer.chose ?? 'answered' : shape}
        </span>
      </button>

      {expanded && (
        <div className="question-body">
          <p className="because">{question.because}</p>

          <p className="raised">
            raised by the <strong>{question.raisedBy.pass}</strong> pass
            {question.raisedBy.file && (
              <>
                {' '}
                in <code>{question.raisedBy.file}</code>
              </>
            )}
            {question.raisedBy.terms.length > 0 && (
              <>
                {' · '}
                {question.raisedBy.terms.map((term, index) => (
                  <span key={term}>
                    {index > 0 && ', '}
                    <TermRef name={term} known={known} onSelect={onSelectTerm} />
                  </span>
                ))}
              </>
            )}
          </p>

          {!decided && onSetBlocking && (
            <p className="blocking-toggle">
              <button
                type="button"
                className="action"
                disabled={busy}
                onClick={() => onSetBlocking(question.id, !blocking)}
                title="Blocking questions rise to the top of the queue"
              >
                {blocking ? 'Clear blocking' : 'Mark blocking'}
              </button>
              <span className="muted">
                {blocking
                  ? 'Flagged blocking — it sits at the top until answered.'
                  : 'Flag if this must be answered before work can continue.'}
              </span>
            </p>
          )}

          {question.options.map((option) => (
            <OptionCard
              key={option.label}
              option={option}
              chosen={decided ? answer.chose === option.label : chose === option.label}
              dimmed={decided && answer.chose !== option.label}
              onChoose={decided ? undefined : () => setChose(chose === option.label ? null : option.label)}
            />
          ))}

          {decided ? (
            <p className="answered-note">
              <strong>Answered {answer.answeredAt.slice(0, 10)}</strong>
              {answer.note && <> — {answer.note}</>}
              {answer.changesetId && (
                <>
                  {' '}
                  · raised changeset <code>{answer.changesetId}</code>
                </>
              )}
            </p>
          ) : (
            <div className="answer-form">
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={
                  chose
                    ? 'Why (optional) — this is what you will want to read in six months.'
                    : 'Answer in your own words — required if you are not taking one of the options.'
                }
                rows={2}
              />
              <div className="answer-actions">
                <span className="muted">
                  {chose
                    ? `Answering "${chose}"${
                        question.options.find((option) => option.label === chose)?.proposal
                          ? ' — its changeset joins the pending queue for review'
                          : ' — no spec change'
                      }`
                    : 'Pick an option, or answer in prose to send it back.'}
                </span>
                <button
                  type="button"
                  className="action action-answer"
                  disabled={busy || (!chose && !note.trim())}
                  onClick={() => onAnswer(question.id, chose, note)}
                >
                  Record answer
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function OptionCard({
  option,
  chosen,
  dimmed,
  onChoose,
}: {
  option: QuestionOption
  chosen: boolean
  dimmed: boolean
  onChoose?: () => void
}) {
  const body = (
    <>
      <div className="option-head">
        <span className="option-label">{option.label}</span>
        {option.proposal ? (
          <span className="muted">
            {option.proposal.ops.length} op{option.proposal.ops.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="muted">changes no specs</span>
        )}
      </div>

      {option.detail && <p className="option-detail">{option.detail}</p>}

      {option.proposal && (
        <>
          <ul className="op-list">
            {option.proposal.ops.map((op, index) => (
              <li key={index} className="op-preview">
                {summarizeOp(op)}
              </li>
            ))}
          </ul>
          {option.proposal.tests.length > 0 && (
            <ul className="test-list">
              {option.proposal.tests.map((test) => (
                <li key={test}>{test}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )

  const className = `option ${chosen ? 'chosen' : ''} ${dimmed ? 'dimmed' : ''}`

  return onChoose ? (
    <button type="button" className={className} onClick={onChoose}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}
