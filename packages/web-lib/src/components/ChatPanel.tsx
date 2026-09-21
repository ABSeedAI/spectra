/**
 * The chat dock. Sits beside the glossary rather than replacing it, so you can read a
 * term while asking about it — the point of putting this in the tool at all was to stop
 * bouncing between a terminal and a browser.
 *
 * `@` references terms, questions and changesets by name. That is the vocabulary this
 * project is about, and it is more useful than referencing files: a term's meaning spans
 * its own file plus everything pointing at it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, ChatEvent, ChatSession, Entity, Mention, Run } from '../chat.js'
import { Markdown } from './Markdown.js'
import {
  DEFAULT_VOICES,
  dictate,
  dictationAvailable,
  fetchRemoteVoices,
  leadSentence,
  rankVoices,
  rearmRemoteVoice,
  speak,
  speakableText,
  speechAvailable,
  stopSpeaking,
  suggestVoices,
  voicesByCategory,
  withDefaultVoices,
} from '../speech.js'
import type { Dictation, RemoteError, RemoteVoice, VoiceChoice } from '../speech.js'
import {
  addresseeOf,
  createSession,
  decideApproval,
  deleteSession,
  fetchChatStatus,
  fetchSessionState,
  groupRuns,
  isNarrative,
  isPendingApproval,
  listAgents,
  setUnattended,
  listSessions,
  matchEntities,
  mentionAt,
  sendMessage,
  streamSession,
} from '../chat.js'

interface ChatPanelProps {
  entities: Entity[]
  /** Something changed on disk — the glossary and queues should be refetched. */
  onSpecsChanged: () => void
  onSelectTerm: (name: string) => void
  onClose: () => void
  /**
   * A stable per-project (or per-user+project) key. When set, the unsent composer draft is saved to
   * localStorage under it and restored — so a session timeout or reload between typing and sending a
   * (possibly very long) message doesn't lose it. Omit to disable persistence.
   */
  draftKey?: string
}

const DRAFT_PREFIX = 'spectra.draft.'
// localStorage throws in a private window or with site data blocked; a lost/kept draft is a nicety,
// never load-bearing, so every access is wrapped and failure is silent.
function readDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_PREFIX + key, value)
    else localStorage.removeItem(DRAFT_PREFIX + key)
  } catch {
    // no-op: persisting the draft is best-effort
  }
}

/**
 * Said plainly, because the honest version is more reassuring than a scary one. The risk is
 * low precisely because of where @coder runs, and the sentence should say why.
 */
const UNATTENDED_HELP =
  'Skip the approval card for this conversation. Only available while @coder is in its sandbox: no network, no credential, and app/ the only thing it can write. Commands on the denylist stay refused, and everything it does is still recorded.'

export function ChatPanel({ entities, onSpecsChanged, onSelectTerm, onClose, draftKey }: ChatPanelProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [agents, setAgents] = useState<Agent[]>([])
  // Restored from localStorage on first render so a reload doesn't start blank (GH: draft persistence).
  const [draft, setDraft] = useState(() => (draftKey ? readDraft(draftKey) : ''))
  // The agent to keep addressing without re-typing @spec/@coder each message. Set to whoever you last
  // @-mentioned; a new @mention switches it; clearable. So a long one-agent chat is just messages.
  const [stuck, setStuck] = useState<string | null>(null)
  // Persist the draft on every change, and reload it when the project (draftKey) changes — so a
  // session timeout or reload between typing and sending a long message keeps it. submit() clears the
  // draft on a successful send, and the persist effect then removes the stored key.
  const draftKeyRef = useRef(draftKey)
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return // not a project switch — don't clobber the live draft
    draftKeyRef.current = draftKey
    setDraft(draftKey ? readDraft(draftKey) : '')
  }, [draftKey])
  useEffect(() => {
    if (draftKey) writeDraft(draftKey, draft)
  }, [draft, draftKey])
  const [unattended, setUnattendedState] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Off unless you turned it on, and remembered because a preference is not a permission —
  // unlike unattended mode, which is deliberately forgotten on restart.
  const [speaking, setSpeaking] = useState(() => localStorage.getItem('tb.speech') === 'on')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [remoteVoices, setRemoteVoices] = useState<RemoteVoice[]>([])
  const [fallback, setFallback] = useState<RemoteError | null>(null)
  const [choices, setChoices] = useState<Record<string, VoiceChoice>>(() => {
    try {
      return { ...DEFAULT_VOICES, ...(JSON.parse(localStorage.getItem('tb.voices') ?? '{}') as object) }
    } catch {
      return DEFAULT_VOICES
    }
  })
  const [listening, setListening] = useState(false)
  const dictation = useRef<Dictation | null>(null)

  // Only terms are linkable; an `@q-004` in prose stays plain rather than becoming a
  // dead link to something the glossary has no page for.
  const known = useMemo(
    () => new Set(entities.filter((entity) => entity.kind === 'term').map((entity) => entity.name)),
    [entities],
  )

  const runs = useMemo(() => groupRuns(events), [events])

  const composer = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<Mention | null>(null)

  useEffect(() => {
    void fetchChatStatus().then((status) => setConfigured(status.configured))
    void listAgents().then(({ agents: found }) => setAgents(found))
    void listSessions().then(({ sessions: found }) => {
      setSessions(found)
      setSessionId((current) => current ?? found[0]?.id ?? null)
    })
  }, [])

  // A tool call that writes lands on disk; the glossary behind this panel is now stale.
  const settled = useCallback(
    (event: ChatEvent) => {
      // Anything that writes to specs/ leaves the glossary behind this panel stale — including the
      // free adds (raise_question/expectation/scenario), whose feeds the panel shows but does not poll.
      const writes = ['raise_question', 'raise_expectation', 'raise_scenario', 'propose_changeset', 'mark_implemented']
      if (event.kind === 'tool_call' && event.status === 'completed' && writes.includes(event.text ?? '')) {
        onSpecsChanged()
      }
    },
    [onSpecsChanged],
  )

  useEffect(() => {
    if (!sessionId) return
    setEvents([])
    setStreaming('')
    // Server-held, so ask rather than assume — after a restart it is correctly off again.
    void fetchSessionState(sessionId)
      .then((state) => setUnattendedState(state.unattended))
      .catch(() => setUnattendedState(false))

    return streamSession(sessionId, 0, {
      onAppend: (event) => {
        setStreaming('')
        setEvents((current) => (current.some((e) => e.id === event.id) ? current : [...current, event]))
      },
      onUpdate: (event) => {
        setEvents((current) => current.map((e) => (e.id === event.id ? event : e)))
        settled(event)
      },
      onDelta: (text) => setStreaming((current) => current + text),
      onReady: setRunning,
      onDone: () => {
        setRunning(false)
        setStreaming('')
      },
    })
  }, [sessionId, settled])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [events, streaming])

  /**
   * Chrome fills the voice list asynchronously and returns an empty array until it has, so
   * this listens as well as asking. Without the event the picker is empty on first paint and
   * both agents fall back to the default voice.
   */
  useEffect(() => {
    if (!speechAvailable()) return

    const load = () => {
      const found = window.speechSynthesis.getVoices()
      if (found.length === 0) return
      setVoices(found)
      setChoices((current) => {
        if (current.spec?.uri || current.coder?.uri) return current
        const suggested = suggestVoices(found)
        return {
          spec: { ...current.spec!, uri: suggested.spec },
          coder: { ...current.coder!, uri: suggested.coder },
        }
      })
    }

    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  /**
   * Asked for once, and only when speech is actually on — the list costs a call to a third
   * party, and a page that reaches out to a vendor for a feature nobody switched on is doing
   * something the reader did not ask for. An empty list is the normal answer and needs no
   * handling: the picker simply shows the system voices, exactly as before.
   */
  useEffect(() => {
    if (!speaking || remoteVoices.length > 0) return
    let live = true
    void fetchRemoteVoices().then((found) => {
      if (!live) return
      setRemoteVoices(found.voices)
      // Applied for this page and deliberately not written back. Persisting it would turn the
      // server's default into a decision this browser had made, and the next edit to .env
      // would then be ignored by the only browser that had ever run — which reads exactly
      // like the setting not working. Only a pick in the picker is stored.
      setChoices((current) => withDefaultVoices(current, found.defaults))
    })
    return () => {
      live = false
    }
  }, [speaking, remoteVoices.length])

  /**
   * Speaks once per run, when the run ends.
   *
   * One rule rather than several, and the simplicity is the point. Watching `running` fall
   * from true means nothing is ever spoken while replaying an old conversation — a page load
   * never sees the transition — so no cursor or baseline is needed to keep history quiet.
   * It also covers failure for free: an error is narrative, so a run that died says why.
   */
  const wasRunning = useRef(false)
  useEffect(() => {
    const finished = wasRunning.current && !running
    wasRunning.current = running
    if (!finished || !speaking) return

    const last = runs[runs.length - 1]?.steps.filter(isNarrative).pop()
    if (!last?.text || last.author === 'human') return

    const text = leadSentence(speakableText(last.text))
    speak(text, {
      ...(choices[last.author] ?? DEFAULT_VOICES.spec!),
      voices,
      onFallback: setFallback,
    })
  }, [running, runs, speaking, choices, voices])

  // Sending supersedes whatever is being said: the answer you were listening to is no longer
  // the thing you are waiting on.
  useEffect(() => () => stopSpeaking(), [])

  function toggleSpeech(on: boolean) {
    setSpeaking(on)
    localStorage.setItem('tb.speech', on ? 'on' : 'off')
    if (!on) stopSpeaking()
  }

  /**
   * One value from one dropdown, carrying which kind of voice it is. A `remote:` prefix means
   * ElevenLabs; anything else is a browser voice URI.
   *
   * Both are always stored. Picking a remote voice does not throw away the local choice — that
   * is the one that speaks when the quota runs out, and a listener who has to re-pick it at
   * exactly the moment it starts mattering has been let down.
   */
  function chooseVoice(agent: string, value: string) {
    const remote = value.startsWith('remote:')
    setChoices((current) => {
      const next = {
        ...current,
        [agent]: {
          ...current[agent]!,
          ...(remote ? { remoteId: value.slice('remote:'.length) } : { uri: value || null, remoteId: null }),
        },
      }
      localStorage.setItem('tb.voices', JSON.stringify(next))
      return next
    })
    // A new choice deserves a fresh attempt, even if the last one failed.
    rearmRemoteVoice()
    setFallback(null)
  }

  /**
   * Dictation fills the composer and never sends.
   *
   * The composer's grammar is sigils — `@spec` to address, `#Task` to refer — and no speech
   * engine produces either, so what lands in the box is always going to need a glance. Making
   * it a draft rather than a message is what turns that from a defect into a normal edit.
   */
  function toggleDictation() {
    if (dictation.current) {
      dictation.current.stop()
      return
    }

    const before = draft ? `${draft} ` : ''
    const started = dictate(
      (text) => setDraft(before + text),
      (cause) => {
        dictation.current = null
        setListening(false)
        if (cause && cause !== 'aborted' && cause !== 'no-speech') setError(`Dictation stopped: ${cause}`)
      },
    )

    if (!started) {
      setError('This browser has no speech recognition — Chrome or Edge have it, Firefox does not.')
      return
    }
    dictation.current = started
    setListening(true)
  }

  /**
   * The server decides. It refuses when there is no reachable sandbox — running in-process
   * means a shell on your real filesystem, where the card is the only boundary — so the
   * checkbox reflects what came back rather than what was clicked.
   */
  async function toggleUnattended(enabled: boolean) {
    setError(null)
    try {
      const outcome = await setUnattended(sessionId!, enabled)
      setUnattendedState(outcome.unattended)
    } catch (cause) {
      setUnattendedState(false)
      setError((cause as Error).message)
    }
  }

  async function start() {
    const { session } = await createSession()
    setSessions((current) => [session, ...current])
    setSessionId(session.id)
  }

  async function submit() {
    const text = draft.trim()
    if (!text || running) return

    let target = sessionId
    if (!target) {
      const { session } = await createSession()
      setSessions((current) => [session, ...current])
      setSessionId(session.id)
      target = session.id
    }

    setDraft('')
    setMention(null)
    setRunning(true)
    setError(null)

    // Explicit @mention wins and becomes the new sticky target; otherwise keep addressing whoever's
    // stuck, so you don't re-type @spec every message. Clearing stick → an unaddressed message again.
    const explicit = addresseeOf(text, agentNames)
    const addressee = explicit ?? stuck
    if (explicit && explicit !== stuck) setStuck(explicit)

    try {
      const outcome = await sendMessage(target, text, addressee)
      if (!outcome.ok) {
        setError(outcome.error ?? 'The message was refused.')
        setRunning(false)
      }
    } catch (cause) {
      setError((cause as Error).message)
      setRunning(false)
    }
  }

  function onDraftChange(value: string, caret: number) {
    setDraft(value)
    setMention(mentionAt(value, caret))
  }

  function insert(name: string, sigil: '@' | '#') {
    if (!mention) return
    const caret = composer.current?.selectionStart ?? draft.length
    setDraft(`${draft.slice(0, mention.from)}${sigil}${name} ${draft.slice(caret)}`)
    setMention(null)
    requestAnimationFrame(() => composer.current?.focus())
  }

  /**
   * Takes the top suggestion, if the list is open. Returns whether it did, so a key that has
   * a job of its own — Tab moves focus, Enter sends — can tell whether it was used up here.
   */
  function completeFirst(): boolean {
    if (agentSuggestions.length > 0) {
      insert(agentSuggestions[0]!.name, '@')
      return true
    }
    if (suggestions.length > 0) {
      insert(suggestions[0]!.name, '#')
      return true
    }
    return false
  }

  const agentNames = agents.map((agent) => agent.name)
  const to = addresseeOf(draft, agentNames)
  // Who a message with no explicit @mention would go to right now.
  const effectiveTo = to ?? stuck

  // `@` completes over who is in the channel, `#` over what the glossary holds.
  const suggestions =
    mention?.sigil === 'artifact' ? matchEntities(entities, mention.query) : []
  const agentSuggestions =
    mention?.sigil === 'agent'
      ? agents.filter((agent) => agent.name.startsWith(mention.query.toLowerCase()))
      : []

  return (
    <aside className="chat">
      <header className="chat-header">
        <strong>Chat</strong>
        <select
          className="chat-sessions"
          value={sessionId ?? ''}
          onChange={(event) => setSessionId(event.target.value || null)}
        >
          {sessions.length === 0 && <option value="">no conversations</option>}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {when(session.updatedAt)} · {session.title}
            </option>
          ))}
        </select>
        <button type="button" className="chat-icon" title="New conversation" onClick={() => void start()}>
          +
        </button>
        {speechAvailable() && (
          <VoiceControls
            remoteVoices={remoteVoices}
            fallback={fallback}
            speaking={speaking}
            onToggle={toggleSpeech}
            voices={voices}
            choices={choices}
            agents={agents}
            onChoose={chooseVoice}
          />
        )}
        {sessionId && (
          <button
            type="button"
            className="chat-icon"
            title="Delete this conversation"
            onClick={async () => {
              await deleteSession(sessionId)
              const { sessions: left } = await listSessions()
              setSessions(left)
              setSessionId(left[0]?.id ?? null)
            }}
          >
            ×
          </button>
        )}
        <button type="button" className="close" onClick={onClose} aria-label="Close chat">
          ⟩
        </button>
      </header>

      {!configured && (
        <p className="chat-warn">
          <code>ANTHROPIC_API_KEY</code> is not set on the server, so the agent cannot run. Messages
          are still recorded.
        </p>
      )}

      <div className="chat-scroll" ref={scroller}>
        {events.length === 0 && !streaming && (
          <div className="chat-empty">
            <p className="muted">Ask about the specs. It can read the glossary, the questions and the pending changesets, work out what conflicts with what, and raise a question — but it cannot edit a term.</p>
            <ul className="chat-hints">
              <li>@spec where should I start?</li>
              <li>@spec why does #deleteProject block instead of cascade?</li>
              <li>@coder implement the changesets that just landed</li>
            </ul>
          </div>
        )}

        {runs.map((run, index) => (
          <RunGroup
            key={run.id}
            run={run}
            // The newest run is the one you are reading, so it never folds itself away
            // mid-sentence. Sending the next message is what turns it into history.
            latest={index === runs.length - 1}
            known={known}
            onSelectTerm={onSelectTerm}
            onDecide={(event, decision, note) => {
              if (event.toolCallId && sessionId) {
                void decideApproval(sessionId, event.toolCallId, decision, note).catch((cause: Error) =>
                  setError(cause.message),
                )
              }
            }}
          />
        ))}

        {streaming && (
          <div className="bubble bubble-assistant">
            {streaming}
            <span className="cursor" />
          </div>
        )}
        {running && !streaming && <p className="muted chat-thinking">thinking…</p>}
      </div>

      {error && <p className="chat-warn">{error}</p>}

      <div className="composer">
        {(suggestions.length > 0 || agentSuggestions.length > 0) && (
          <ul className="mentions">
            {agentSuggestions.map((agent) => (
              <li key={`agent-${agent.name}`}>
                <button type="button" onClick={() => insert(agent.name, '@')}>
                  <span className="mention-kind mention-agent">agent</span>
                  <span className="mention-name">@{agent.name}</span>
                  <span className="muted mention-hint">{agent.description}</span>
                </button>
              </li>
            ))}
            {suggestions.map((entity) => (
              <li key={`${entity.kind}-${entity.name}`}>
                <button type="button" onClick={() => insert(entity.name, '#')}>
                  <span className={`mention-kind mention-${entity.kind}`}>{entity.kind}</span>
                  <span className="mention-name">#{entity.name}</span>
                  <span className="muted mention-hint">{entity.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={composer}
          value={draft}
          rows={3}
          placeholder="@spec or @coder to address someone, # to refer to a term or change"
          onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMention(null)
            // Tab completes only while the list is open. Swallowing it the rest of the time
            // would trap the keyboard in the composer, and the way out of a text box is Tab.
            if (event.key === 'Tab' && !event.shiftKey) {
              if (completeFirst()) event.preventDefault()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (!completeFirst()) void submit()
            }
          }}
        />
        <div className="composer-actions">
          <span className="muted">
            {mention ? (
              <>
                Tab to complete <strong>{mention.sigil === 'agent' ? '@' : '#'}{mention.query}</strong>
              </>
            ) : effectiveTo ? (
              <>
                to <strong className={`author author-${effectiveTo}`}>@{effectiveTo}</strong>
                {!to && stuck ? <span className="muted"> (sticky)</span> : null} · Enter to send
              </>
            ) : (
              'Address @spec or @coder — an unaddressed message is recorded but acted on by nobody'
            )}
          </span>
          {/* Who you're addressing without re-typing @spec/@coder. Set by your last @mention; switch by
              @-mentioning the other agent; ✕ to stop and go back to explicit addressing. */}
          {stuck && (
            <span className={`stick author-${stuck}`} title={`Replying to @${stuck} — @-mention the other agent to switch, or ✕ to stop`}>
              ↳ @{stuck}
              <button type="button" className="stick-clear" onClick={() => setStuck(null)} aria-label={`Stop replying to @${stuck}`}>
                ✕
              </button>
            </span>
          )}
          {/*
            Kept visible while it is on, not tucked into a menu. A permission you cannot see
            from where the work is happening is one you forget you granted.
          */}
          <label className={`unattended ${unattended ? 'unattended-on' : ''}`} title={UNATTENDED_HELP}>
            <input type="checkbox" checked={unattended} onChange={(event) => void toggleUnattended(event.target.checked)} />
            let @coder work unattended
          </label>
          {dictationAvailable() && (
            <button
              type="button"
              className={`chat-icon mic ${listening ? 'mic-on' : ''}`}
              title={
                listening
                  ? 'Stop dictating'
                  : 'Dictate into the box. It never sends on its own — @ and # do not dictate, so read it back first.'
              }
              onClick={toggleDictation}
            >
              {listening ? '◉' : '🎤'}
            </button>
          )}
          <button type="button" className="action" disabled={running || !draft.trim()} onClick={() => void submit()}>
            Send
          </button>
        </div>
      </div>
    </aside>
  )
}

/**
 * One human turn and everything that followed it, at one of three depths.
 *
 * The problem this solves only appears once @coder does real work: twenty tool calls and a
 * few approval cards sit between "Now updating the tests" and "Tests and typecheck pass", and
 * the two sentences that say what actually happened become the hardest things on screen to
 * find. Nothing is discarded — the depths differ only in what is folded.
 *
 *   narrative  what it said, with what it did folded into one strip   (default, live)
 *   folded     the first thing it said and the last                   (default, history)
 *   full       every event, as before
 *
 * Live runs default to narrative because you are watching it think and the tool calls are
 * noise; finished ones fold once they stop being the newest, because by then you want the
 * conclusion and the way back to it. A run that only ever said one thing never folds — there
 * would be nothing to hide and a fold bar would be a lie about there being more.
 */
type Depth = 'folded' | 'narrative' | 'full'

/**
 * Which voice each agent gets, and whether anyone is speaking at all.
 *
 * Two agents want two voices, but voice availability is the operating system's business and
 * a bare Linux browser may offer one or none. So the pickers show whatever exists, and the
 * agents stay distinguishable by pitch and rate regardless — that fallback is in the defaults
 * rather than here, so it holds even when nothing is chosen.
 */
function VoiceControls({
  speaking,
  onToggle,
  voices,
  choices,
  agents,
  onChoose,
  remoteVoices,
  fallback,
}: {
  speaking: boolean
  onToggle: (on: boolean) => void
  voices: SpeechSynthesisVoice[]
  choices: Record<string, VoiceChoice>
  agents: Agent[]
  onChoose: (agent: string, uri: string) => void
  remoteVoices: RemoteVoice[]
  fallback: RemoteError | null
}) {
  const [open, setOpen] = useState(false)
  const ranked = rankVoices(voices)

  return (
    <div className="voice">
      <button
        type="button"
        className={`chat-icon ${speaking ? 'voice-on' : ''}`}
        title={speaking ? 'Stop reading replies aloud' : 'Read each reply aloud when it finishes'}
        onClick={() => onToggle(!speaking)}
      >
        {speaking ? '🔊' : '🔇'}
      </button>

      {speaking && (ranked.length > 0 || remoteVoices.length > 0) && (
        <button
          type="button"
          className="chat-icon"
          title="Pick a voice for each agent"
          onClick={() => setOpen(!open)}
        >
          ⋯
        </button>
      )}

      {open && speaking && (
        <div className="voice-picker">
          {agents.map((agent) => (
            <label key={agent.name}>
              <span className={`author author-${agent.name}`}>@{agent.name}</span>
              {/*
                One control, not two. The value carries which kind it is, because "which voice
                do you want" is a single question and splitting it into a provider dropdown and
                a voice dropdown would make the listener answer it twice.
              */}
              <select
                value={
                  choices[agent.name]?.remoteId
                    ? `remote:${choices[agent.name]!.remoteId}`
                    : (choices[agent.name]?.uri ?? '')
                }
                onChange={(event) => onChoose(agent.name, event.target.value)}
              >
                <option value="">browser default</option>
                {ranked.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </option>
                ))}
                {voicesByCategory(remoteVoices).map((group) => (
                  <optgroup
                    key={group.category}
                    label={`ElevenLabs ${group.category} — sends the sentence to them`}
                  >
                    {group.voices.map((voice) => (
                      <option key={voice.id} value={`remote:${voice.id}`}>
                        {voice.name}
                        {voice.description ? ` — ${voice.description}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ))}
          {/*
            Said out loud rather than left to be inferred from silence. A voice that quietly
            stopped being the one you picked is a bug report waiting to happen.
          */}
          {fallback && (
            <p className="chat-warn">
              {fallback.reason === 'quota'
                ? `ElevenLabs will not bill this (${fallback.detail}) — out of credit, or a voice your plan does not include. The browser voice is speaking instead.`
                : fallback.reason === 'no-credential'
                  ? 'No ELEVENLABS_API_KEY on the server — the browser voice is speaking instead.'
                  : fallback.reason === 'rate-limit'
                    ? 'ElevenLabs rate-limited that one; the browser voice took it.'
                    : `ElevenLabs could not speak (${fallback.detail}) — using the browser voice.`}
            </p>
          )}
          <p className="muted">
            Only the last thing an agent says in a run is read, with code left out. Silence while
            it works.
          </p>
        </div>
      )}
    </div>
  )
}

function RunGroup({
  run,
  latest,
  known,
  onSelectTerm,
  onDecide,
}: {
  run: Run
  latest: boolean
  known: Set<string>
  onSelectTerm: (name: string) => void
  onDecide: (event: ChatEvent, decision: 'allow' | 'deny', note?: string) => void
}) {
  const [override, setOverride] = useState<Depth | null>(null)

  const narrative = run.steps.filter(isNarrative)
  const depth: Depth = override ?? (latest ? 'narrative' : 'folded')

  // Fewer than two things said means folding would hide nothing, so the control is not
  // offered — an expander over an empty middle is worse than no expander.
  const foldable = narrative.length > 1
  const effective: Depth = depth === 'folded' && !foldable ? 'narrative' : depth

  const bubble = (event: ChatEvent) => (
    <Bubble
      key={event.id}
      event={event}
      known={known}
      onSelectTerm={onSelectTerm}
      onDecide={(decision, note) => onDecide(event, decision, note)}
    />
  )

  if (effective === 'full') {
    return (
      <div className="run">
        {run.prompt && bubble(run.prompt)}
        {run.steps.map(bubble)}
        <RunBar depth={effective} onChange={setOverride} steps={run.steps.length} />
      </div>
    )
  }

  if (effective === 'folded') {
    const first = narrative[0]!
    const last = narrative[narrative.length - 1]!
    // Everything between the two, including anything still waiting on you.
    const hidden = run.steps.filter((step) => step.id !== first.id && step.id !== last.id)
    const pending = hidden.filter(isPendingApproval)

    return (
      <div className="run">
        {run.prompt && bubble(run.prompt)}
        {bubble(first)}
        <button type="button" className="run-fold" onClick={() => setOverride('narrative')}>
          {hidden.length} step{hidden.length === 1 ? '' : 's'} hidden — show what it did
        </button>
        {/* A blocked approval is never folded away: the run is suspended until it is
            answered, and hiding it would stall the agent with no visible cause. */}
        {pending.map(bubble)}
        {bubble(last)}
        <RunBar depth={effective} onChange={setOverride} steps={run.steps.length} />
      </div>
    )
  }

  // Narrative: prose in full, everything else folded into runs of adjacent steps.
  const blocks: Array<{ kind: 'say'; event: ChatEvent } | { kind: 'did'; events: ChatEvent[] }> = []
  for (const step of run.steps) {
    if (isNarrative(step) || isPendingApproval(step)) {
      blocks.push({ kind: 'say', event: step })
      continue
    }
    const tail = blocks[blocks.length - 1]
    if (tail?.kind === 'did') tail.events.push(step)
    else blocks.push({ kind: 'did', events: [step] })
  }

  return (
    <div className="run">
      {run.prompt && bubble(run.prompt)}
      {blocks.map((block, index) =>
        block.kind === 'say' ? (
          bubble(block.event)
        ) : (
          <StepStrip key={`did-${index}`} events={block.events} render={bubble} />
        ),
      )}
      <RunBar depth={effective} onChange={setOverride} steps={run.steps.length} foldable={foldable} />
    </div>
  )
}

/** The depth control, kept quiet — it is a way back to detail, not a thing to read. */
function RunBar({
  depth,
  onChange,
  steps,
  foldable = true,
}: {
  depth: Depth
  onChange: (depth: Depth) => void
  steps: number
  foldable?: boolean
}) {
  if (steps === 0) return null

  return (
    <div className="run-bar">
      {depth !== 'folded' && foldable && (
        <button type="button" onClick={() => onChange('folded')}>
          fold
        </button>
      )}
      {depth !== 'narrative' && (
        <button type="button" onClick={() => onChange('narrative')}>
          what it said
        </button>
      )}
      {depth !== 'full' && (
        <button type="button" onClick={() => onChange('full')}>
          everything
        </button>
      )}
    </div>
  )
}

/**
 * A stretch of tool calls, as one line until asked otherwise.
 *
 * It names the tools rather than counting them. "6 steps" tells you nothing you can act on;
 * "read_glossary, Edit ×3, Bash" tells you whether the thing you are looking for is in there,
 * which is the only reason to expand it.
 */
function StepStrip({
  events,
  render,
}: {
  events: ChatEvent[]
  render: (event: ChatEvent) => JSX.Element
}) {
  const [open, setOpen] = useState(false)

  if (open) {
    return (
      <div className="strip-open">
        {events.map(render)}
        <button type="button" className="strip-close" onClick={() => setOpen(false)}>
          fold these away
        </button>
      </div>
    )
  }

  const counts = new Map<string, number>()
  for (const event of events) {
    const name = event.text ?? event.kind
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const failed = events.some((event) => event.status === 'failed')

  return (
    <button type="button" className={`strip ${failed ? 'strip-failed' : ''}`} onClick={() => setOpen(true)}>
      <span className="strip-count">{events.length}</span>
      <span className="strip-names">
        {[...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(' · ')}
      </span>
      {failed && <span className="strip-flag">one failed</span>}
    </button>
  )
}

function Bubble({
  event,
  known,
  onSelectTerm,
  onDecide,
}: {
  event: ChatEvent
  known: Set<string>
  onSelectTerm: (name: string) => void
  onDecide: (decision: 'allow' | 'deny', note?: string) => void
}) {
  if (event.kind === 'approval') return <Approval event={event} onDecide={onDecide} />
  if (event.kind === 'tool_call') return <ToolCall event={event} />

  if (event.kind === 'error') {
    return (
      <div className="bubble bubble-error">
        <span className={`author author-${event.author}`}>@{event.author}</span>
        {event.text}
      </div>
    )
  }

  // Your own message renders exactly as typed. Only an agent's prose is Markdown.
  if (event.kind === 'user') {
    return <div className="bubble bubble-user">{event.text}</div>
  }

  return (
    <div className={`bubble bubble-${event.kind} bubble-from-${event.author}`}>
      <span className={`author author-${event.author}`}>@{event.author}</span>
      <Markdown text={event.text ?? ''} known={known} onSelectTerm={onSelectTerm} />
    </div>
  )
}

/**
 * The agent is genuinely blocked while this is on screen — the run is suspended inside the
 * SDK's permission callback until one of these buttons is pressed. It renders from the
 * transcript rather than a live message, so reloading the page does not strand the run.
 */
function Approval({
  event,
  onDecide,
}: {
  event: ChatEvent
  onDecide: (decision: 'allow' | 'deny', note?: string) => void
}) {
  const [note, setNote] = useState('')
  const detail = event.payload as { input?: Record<string, unknown>; decision?: string; note?: string } | null
  const settled = event.status === 'completed'
  const allowed = detail?.decision === 'allow'
  // Distinguished from a decision you made. The transcript records both, and reading back a
  // run later, "I approved this" and "nobody was asked" are not the same fact.
  const auto = allowed && detail?.note === 'unattended'

  return (
    <div className={`approval ${settled ? (allowed ? 'approval-allowed' : 'approval-denied') : 'approval-pending'}`}>
      <div className="approval-head">
        <span className={`author author-${event.author}`}>@{event.author}</span>
        <strong>{event.text}</strong>
        <span className="muted">
          {settled ? (auto ? 'ran unattended' : allowed ? 'approved' : 'declined') : 'waiting on you'}
        </span>
      </div>

      <Input input={detail?.input} />

      {settled ? (
        detail?.note && <p className="muted approval-note">{detail.note}</p>
      ) : (
        <div className="approval-actions">
          <input
            value={note}
            onChange={(input) => setNote(input.target.value)}
            placeholder="Why (optional) — sent back either way"
            aria-label="Reason"
          />
          <button type="button" className="action action-apply" onClick={() => onDecide('allow', note)}>
            Approve
          </button>
          <button type="button" className="action" onClick={() => onDecide('deny', note)}>
            Decline
          </button>
        </div>
      )}
    </div>
  )
}

/** File tools carry the whole new content, which is the part worth actually reading. */
function Input({ input }: { input?: Record<string, unknown> }) {
  if (!input) return null
  const {
    file_path: file,
    content,
    new_string: next,
    old_string: previous,
    command,
    description,
    ...rest
  } = input

  return (
    <div className="approval-input">
      {/* A command is the whole decision, so it leads rather than sitting in the JSON. */}
      {typeof command === 'string' && <pre className="approval-diff approval-command">{command}</pre>}
      {typeof description === 'string' && <p className="muted approval-note">{description}</p>}
      {typeof file === 'string' && <code className="approval-file">{file}</code>}
      {typeof previous === 'string' && <pre className="approval-diff approval-old">{previous}</pre>}
      {typeof next === 'string' && <pre className="approval-diff approval-new">{next}</pre>}
      {typeof content === 'string' && <pre className="approval-diff approval-new">{content}</pre>}
      {Object.keys(rest).length > 0 && <pre className="approval-diff">{JSON.stringify(rest, null, 2)}</pre>}
    </div>
  )
}

function ToolCall({ event }: { event: ChatEvent }) {
  const [open, setOpen] = useState(false)
  const detail = event.payload as { input?: unknown; output?: unknown } | null

  return (
    <div className={`tool tool-${event.status ?? 'started'}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        <span className={`author author-${event.author}`}>@{event.author}</span>
        <code>{event.text}</code>
        <span className="muted">{event.status === 'started' ? 'running…' : event.status}</span>
      </button>
      {open && detail && (
        <pre className="tool-detail">{JSON.stringify(detail, null, 2)}</pre>
      )}
    </div>
  )
}

/**
 * Conversations are titled from their first message, which collides constantly — ask
 * "where should I start?" three times and you get three identical entries. The timestamp
 * is what actually distinguishes them.
 */
function when(iso: string): string {
  const at = new Date(iso)
  const today = new Date().toDateString() === at.toDateString()
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return today ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}
