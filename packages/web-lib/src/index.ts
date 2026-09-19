/**
 * `@abseed/spectra-web-lib` — the reusable half of the spec-tool UI: the presentational components,
 * the transport-injected glossary behavior (`useGlossary`), the chat subsystem, and the styles.
 *
 * A host builds its own shell — layout, routing, auth, the marketing pages a product grows — and
 * composes these pieces into it, injecting its own `GlossaryTransport` (and, for chat's live half, a
 * `ChatTransport` via `setChatTransport`). The local tool's shell in `@abseed/spectra-web` is one such
 * host; it drives everything against same-origin REST. Nothing here reaches a `fetch` of its own: the
 * behavior depends only on the `GlossaryTransport` interface, so the same flows run against any backend.
 *
 * Importing this pulls the styles in as a side effect, so a consumer gets the styled UI from one import.
 */
import './styles.css'

// The presentational components — a shell lays these out however it likes; each takes data and
// callbacks as props and reaches for no transport of its own.
export { HighlightLegend } from './components/BacklinkHighlight.js'
export { ChangesetBar } from './components/ChangesetBar.js'
export { ChangesetReview } from './components/ChangesetReview.js'
export { ChatPanel } from './components/ChatPanel.js'
export { CoveragePanel } from './components/CoveragePanel.js'
export { QuestionPanel } from './components/QuestionPanel.js'
export { ScenarioPanel } from './components/ScenarioPanel.js'
export { ProjectSwitcher } from './components/ProjectSwitcher.js'
export { SearchBar, filterTerms } from './components/SearchBar.js'
export { TermDetail } from './components/TermDetail.js'
export type { SupersedeDraft } from './components/TermDetail.js'
export { TermList } from './components/TermList.js'

// The glossary behavior — bootstrap, project selection, the commit/answer/expectation flows — lifted
// out of any shell. A host calls `useGlossary(itsTransport)` and renders the returned state.
export { useGlossary } from './useGlossary.js'
export type { Notice } from './useGlossary.js'

// The glossary transport seam and its data contracts. A host implements `GlossaryTransport`; the types
// are the shape of what crosses that boundary.
export type {
  GlossaryTransport,
  Context,
  Org,
  ProjectSummary,
  Glossary,
  ChangesetFeed,
  QuestionFeed,
  ExpectationFeed,
  ScenarioFeed,
  CommitOutcome,
  AnswerOutcome,
  RaiseOutcome,
  ExpectationDraft,
  CheckReport,
  SupersedeOutcome,
} from './glossaryTransport.js'

// The chat subsystem's live-transport seam and its contracts. Static chat reads stay same-origin REST
// a host serves; the live half (send, approve, stream) is swapped with `setChatTransport`.
export { setChatTransport } from './chat.js'
export type { ChatTransport, StreamHandlers, ChatEvent, Entity } from './chat.js'

// Speech pieces a host needs to build its own voice picker: the per-agent choice shape and its
// defaults (the `tb.voices` localStorage contract the ChatPanel reads), the remote-voice type, and
// the ordering/grouping helpers. A host that offers its own picker reuses these so its stored shape
// cannot drift from the one ChatPanel plays.
export { DEFAULT_VOICES, rankVoices, voicesByCategory, withDefaultVoices } from './speech.js'
export type { VoiceChoice, RemoteVoice } from './speech.js'

// The project-scoping prefix every same-origin call goes through — a host serving REST configures it
// once at startup, like the local tool does.
export { apiPath, configureProject, currentProject } from './apiBase.js'

// The changeset projection a shell renders while a proposal is open.
export { reviewChangeset } from './review.js'
