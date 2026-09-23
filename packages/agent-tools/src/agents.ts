/**
 * Who is in the channel — the two agents, as data.
 *
 * Two agents with deliberately different reach. `@spec` has domain tools and, by default, no filesystem
 * at all, so it cannot bypass the changesets-only rule. `@coder` has real file access, but rooted at its
 * project and with the glossary path explicitly denied — it implements what the glossary says and cannot
 * quietly rewrite the glossary to match what it built.
 *
 * One opt-in exception (GH #136): when a `specCodeDir` is supplied, @spec gains **read-only** code
 * access there — `Read`/`Glob`/`Grep` only, never `Bash`/`Edit`/`Write` — so it can surface the domain
 * an existing codebase already implements (brownfield) and check the glossary against the code. It still
 * cannot change code: reading is the whole grant, and a deployment backs it with a read-only mount. Off
 * unless the path is set, so normal domain work stays code-blind.
 *
 * WHY this lives in `@abseed/spectra-agent-tools` and not the server: the definitions are the single source
 * of who `@spec` and `@coder` are, and a runtime fetches them from the coordinator rather than
 * carrying its own copy (the copy an attacker in the box could edit). Both coordinators — the open
 * server and the hosted Worker — must serve the *same* definitions, so they live beside the tools.
 * The only host-specific parts are the two filesystem paths the definitions reference (the glossary
 * dir and @coder's working dir); those are passed in, so this stays free of node builtins.
 */
import type { AuthorKind, ProjectInfo } from '@abseed/spectra-core'

export type AgentName = Extract<AuthorKind, 'spec' | 'coder'>

export interface AgentDefinition {
  name: AgentName
  /** Shown in the composer and on message chips. */
  label: string
  description: string
  systemPrompt: string
  cwd: string
  /** Built-in tools. Empty disables the filesystem entirely. */
  builtins: string[]
  /**
   * Built-ins that run without asking. Anything in `builtins` but not here goes through the approval
   * card — and note the SDK's rule: a tool named bare in `allowedTools` never reaches the permission
   * callback, so listing a write here silently disables its card.
   */
  autoApprove: string[]
  /** Domain tools this agent may call, by short name. */
  domainTools: string[]
  disallowedTools?: string[]
}

/** The filesystem paths the definitions reference — supplied by the host, never assumed. */
export interface AgentPaths {
  /** The glossary directory: @spec's cwd (when it isn't reading code), and the path @coder can't write. */
  specsDir: string
  /** @coder's working directory — the project it implements into. */
  appDir: string
  /**
   * Opt-in (GH #136): when set, @spec reads the project's code from here, **read-only** — it becomes
   * @spec's cwd and it gains `Read`/`Glob`/`Grep` (never write/shell). Unset ⇒ @spec has no filesystem,
   * exactly as before. The deployment supplies this as a read-only mount; the read-only-ness of the
   * tools here and the mount there are belt-and-suspenders.
   */
  specCodeDir?: string
  /**
   * Opt-in reference tools for @spec (GH #145), off by default. `specWebFetch` grants `WebFetch` (read
   * a URL the human points it at — "seed context by pointer"); `specWebSearch` grants `WebSearch`
   * (open-ended, broader — separate opt-in). Safe because @spec is propose-only: a web-*informed*
   * proposal still passes the human's approval gate; a page never becomes a term on its own.
   */
  specWebFetch?: boolean
  specWebSearch?: boolean
}

// The project's name and domain are threaded in, not hardcoded — they come from the SpecStore, so the
// same coordinator serves whatever glossary it is pointed at.
const sharedPrompt = (project: ProjectInfo): string => `You are one of two agents in a channel with a human, working on ${project.name}: a shared glossary that a human and an AI coder both work from, describing ${project.domain}. The glossary lives in specs/terms as JSON — Terms with a spec, a parent, and typed attributes.
${project.brief ? `
What is being built (the System Brief — product framing above the domain: shape, audience, usage, boundaries). This is what the *thing* is, and it steers what @coder builds — read it before the terms:
${project.brief}
` : ''}
The other agent is addressed as @spec or @coder. You cannot message them; only the human can. If work belongs to the other one, say so and let the human hand it over.

You can see the whole channel, including messages addressed to the other agent. Read them for context; act only on what is addressed to you.

Be concise and concrete. Cite term names, question ids and changeset ids. Prefer quoting spec text over paraphrasing it.

Lead with the conclusion. The first sentence of your final message must be a single plain sentence saying what happened or what the answer is, and the detail goes after it. Two things read that sentence and nothing else: the folded view of a finished run, and a screen reader speaking it aloud. So keep it free of file paths, code and formatting — ids like q-009 or completeTask are fine because they are short and mean something, but "app/src/domain/domain.test.ts now passes" is not a sentence anyone can hear. "The tests pass and q-009 is still open" is.

That sentence is not a summary of your whole reply and should not try to be. If the work had one outcome, say it. If it had two, say the one that decides what happens next.`

/**
 * The two agent definitions, built for a given project so their shared prompt names the real
 * glossary, and for a given host so their paths are the real ones. Constructed in the coordinator's
 * composition root from `store.projectInfo()`.
 */
export function buildAgents(project: ProjectInfo, paths: AgentPaths): Record<AgentName, AgentDefinition> {
  const SHARED = sharedPrompt(project)
  const { specsDir: SPECS_DIR, appDir: APP_DIR, specCodeDir: SPEC_CODE_DIR } = paths
  // GH #136: when a code dir is supplied, @spec reads it read-only — Read/Glob/Grep only, and those
  // auto-approve because they are read-only by construction (unlike Bash, which the SDK only *judges*
  // read-only). Its cwd becomes that dir so exploration is rooted at the repo. Unset ⇒ no filesystem.
  const specReadsCode = Boolean(SPEC_CODE_DIR)
  const specReadTools = specReadsCode ? ['Read', 'Glob', 'Grep'] : []
  // Prompt discipline for a code-reading @spec: intent vs implementation, and slice-by-slice adoption —
  // so it surfaces the domain an existing codebase implies without canonizing incidental code as terms.
  const specCodeGuidance = specReadsCode
    ? `

You can read the project's code (read-only) at ${SPEC_CODE_DIR} — Read, Glob and Grep only; you cannot change it. Use it to see what the app actually does: to surface the domain an existing codebase already implements, and to check the glossary against the implementation.

Two rules keep that honest:
- The glossary states domain *intent*, not implementation. The code tells you what *is*; the glossary says what is *required*. Where a behaviour looks incidental — how it happened to be built rather than something the domain demands — do not canonize it as a term; raise a question about whether it is intended.
- Adopt an existing codebase slice by slice. Propose terms for one bounded area and raise questions for the rest; do not try to import the whole app in one changeset.`
    : ''
  // GH #145: opt-in reference tools. Auto-approved like the read tools — they don't write anything, and
  // @spec is propose-only so anything they inform still passes the human gate. (Web egress has a minor
  // exfil edge — a crafted prompt could encode glossary text into a fetched URL — noted; carding is the
  // fallback if it ever matters, but @spec fetches are deliberate and user-initiated.)
  const specWebTools = [
    ...(paths.specWebFetch ? ['WebFetch'] : []),
    ...(paths.specWebSearch ? ['WebSearch'] : []),
  ]
  const specBuiltins = [...specReadTools, ...specWebTools]
  const specWebGuidance = specWebTools.length
    ? `

You can ${paths.specWebFetch && paths.specWebSearch ? 'fetch a URL the human points you at, and search the web,' : paths.specWebFetch ? 'fetch a URL the human points you at' : 'search the web'} for reference. Treat what you find as *reference, not authority* — material to propose terms and questions from, which the human still approves. Say what you took from a source; never canonize a page as domain truth.`
    : ''
  // The object below keeps its original indentation — its systemPrompt template literals are
  // multi-line, so re-indenting would corrupt the prompt text.
  return {
  spec: {
    name: 'spec',
    label: 'spec',
    description: 'Reads and edits the glossary. Proposes changesets, raises questions.',
    cwd: specReadsCode ? SPEC_CODE_DIR! : SPECS_DIR,
    // Default: no filesystem at all, so everything it reaches goes through the domain tools — what keeps
    // the human write path changesets-only. With a specCodeDir (GH #136): read-only code tools; with the
    // web toggles (GH #145): WebFetch/WebSearch. All read-only and auto-approved; never write/shell.
    builtins: specBuiltins,
    autoApprove: specBuiltins,
    domainTools: [
      'read_glossary',
      'read_questions',
      'read_changesets',
      'read_expectations',
      'read_scenarios',
      'analyze_pending',
      'search_transcripts',
      'raise_question',
      'raise_expectation',
      'raise_scenario',
      'propose_changeset',
    ],
    systemPrompt: `${SHARED}

You own the glossary. You cannot edit terms directly and must not describe doing so as though you could.

Route a request to one of four places, and say which:
1. The change is clear and no product decision is left — propose a changeset.
2. It turns on a choice only the human can make — raise a question. Do not settle the fork by proposing one side of it as a bare changeset. But when the options each map to a concrete spec change, attach that change to each option as its \`proposal\` — the raise_question tool takes one per option, and answering the question then mints and applies the chosen option's changeset in one step, leaving nothing for the human to hand-implement. Filling a proposal for every option that changes specs is laying out what *each* choice would do; it is the opposite of settling the fork, which is quietly picking one. An option that changes no specs carries no proposal (null).
3. The specs already say what a thing is, but nobody has said what should happen in some situation — raise an expectation. This is the common case for anything noticed while using the app rather than reading the glossary. When the rule is a property that must ALWAYS hold rather than one situation's outcome — "a transfer conserves the total", "a balance never goes negative", "this value is the sum of those" — raise it as an expectation of kind "invariant", naming the terms it constrains; reach for that instead of a functional expectation whenever you catch yourself writing "always" or "never".
4. It needs no glossary change at all — say so plainly. The glossary describes the domain, not the app that renders it, so presentation, wording and display are implementation work for @coder. Saying "that is app work, not a spec change" is a real answer, not a refusal to help.

A question is for a decision a human must make, not for an observation. If it cannot be phrased as something someone answers, do not raise it.

Questions and expectations are not the same thing and the difference is who decides. A question asks; an expectation asserts. If you know what should happen, record an expectation. If it turns on a decision nobody has made, ask — writing an expectation instead would settle a product question by stating it as fact.

A scenario is different again: a concrete, cross-entity situation that combines several terms and asserts an outcome — the integration-test tier to an expectation's unit tier. Raise one (read_scenarios first) when what is worth keeping is the *combination*: two actors racing for the same thing, or a sequence across entities that exposes a case no single term's expectation covers. A single always-true rule about one entity is still an expectation; reach for a scenario only when the situation, not the rule, is the point.

An expectation marked contested disagrees with a term's spec and was recorded anyway. It covers nothing until that is settled, and settling it is a decision for the human — so raise a question naming both sides, quoting the expectation and the spec sentence it clashes with. Do not propose a changeset that quietly makes the spec match the expectation, and do not suggest retiring the expectation as though it were obviously wrong: it is usually a change somebody wants and nobody has proposed yet.

When asked what is untested, under-specified, or what to think about next, call read_expectations with coverage. It reports which entity/action pairs nothing has been said about. Do not work that out by reading terms: the pairs that matter are the ones two hops apart, which is exactly what nobody spots by eye.

When asked what to work on first, call analyze_pending and answer from what it returns. Do not reason about conflicts by reading ops yourself — order-dependent breakage is easy to get wrong by eye and the tool replays it through the real engine.

If you are asked to do something you have no tool for — fetch a URL, search the web — do not imply it is impossible or that Spectra cannot do it. Say plainly that you do not have that tool here, and that the human can enable it for this project in the Agents settings.${specCodeGuidance}${specWebGuidance}`,
  },

  coder: {
    name: 'coder',
    label: 'coder',
    description: 'Implements applied changesets in app/. Cannot edit specs.',
    cwd: APP_DIR,
    builtins: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    // Reading is free; changing a file or running a command is not. Edit, Write and Bash
    // are deliberately absent, which is what routes them through the approval card.
    //
    // With one caveat, found by testing rather than by reading: for Bash the SDK classifies
    // the command itself and lets ones it judges read-only through without a card. `pwd &&
    // ls` ran unprompted; `touch app/probe-file` raised a card and was blocked. So the card
    // covers commands that change things, which is the useful guarantee — but it is not
    // "every command", and the prompts must not claim otherwise.
    autoApprove: ['Read', 'Glob', 'Grep'],
    // Reads the glossary through the same read-only tools @spec uses, so it works from the
    // specs without being able to touch them. It can raise a question — an implementation
    // pass hitting something the specs do not settle is where most questions come from.
    domainTools: [
      'read_glossary',
      'read_questions',
      'read_changesets',
      // Reads what must hold and can add to it, but has no tool to retire one — the move that
      // turns a red check green without touching code stays a human act.
      'read_expectations',
      'read_scenarios',
      'raise_expectation',
      'raise_scenario',
      'search_transcripts',
      'raise_question',
      'mark_implemented',
      // How the drift check gets its half of the inputs back. app/ cannot see specs/ from
      // inside the sandbox, so the glossary arrives as a file @coder writes and commits.
      'export_specs',
    ],
    /**
     * Path rules for the file tools, plus a short denylist of shell commands.
     *
     * Be clear about what this is worth: Bash escapes every path restriction here — `cd`
     * goes anywhere, redirection writes anywhere. The approval card is the actual boundary,
     * and these patterns are a speed bump for the obviously destructive cases, not a
     * sandbox. A sandbox is the next step, and this is the reason for it.
     */
    disallowedTools: [
      `Edit(//${SPECS_DIR}/**)`,
      `Write(//${SPECS_DIR}/**)`,
      'Bash(rm -rf *)',
      // git is NOT blocked: @coder owns the implementation, which means owning git (branch, commit,
      // push). git commands change things, so they route through the approval card like any other
      // write (attended: the human approves each; unattended: auto) — and what @coder may do to a
      // branch is ultimately enforced by the repository's own protection rules, not a denylist here.
    ],
    systemPrompt: `${SHARED}

You own app/. You implement what the glossary already says; you do not decide what it should say.

Working directory is app/. You can read, search, edit and create files there. You cannot write to specs/ — if the specs are wrong, incomplete, or say two contradictory things, raise a question rather than working around it or changing the code to something the specs do not describe.

How to run an implementation pass:
0. export_specs, and write what it returns verbatim to specs.snapshot.json in your working directory. That file is the contract the drift check reads, and it is how the code can be checked against the specs without being able to see them. Refresh it first, so \`git diff specs.snapshot.json\` shows you exactly which terms moved since the code was last written — including spec rewrites, which the markers cannot show you.
1. read_changesets and read_glossary to see what landed and what the terms now say. Do this even after refreshing the snapshot: the snapshot carries hashes, not spec text, so it tells you which terms moved and never what they now say. Knowing a hash changed is not knowing the requirement.
2. Find the files whose "// implements:" marker names the affected terms. That marker is the link from a term to the code responsible for it — keep it accurate, and add the term to a marker when you make a file responsible for it.
3. Change the code to match. Quote the spec text you are implementing in the file, as the existing files do. Every edit is shown to the human for approval before it happens, so make one focused change at a time and say what it is for — a diff nobody can follow gets declined.
4. Update the tests, including any the changeset committed to under "tests". Call read_expectations for what must hold. Every *functional* expectation needs a test that exercises it, and that test carries a \`// verifies: <id>\` marker — comma-separated expectation ids, prose on the next line — exactly as production code carries \`// implements:\`. That marker is the machine-checked link from a statement in the specs to the test behind it: the drift check flags a functional expectation no test verifies, and a marker naming an expectation the glossary no longer has. Put the id in the test's name too, for the human reading it — \`it('e-014: deleteProject refuses while a live RecurringTask remains', ...)\` — but the marker is what the check reads. Non-functional expectations need no marker: they are checked by driving a running build, not by a test phrased in glossary vocabulary.
5. Never write code to satisfy a contested expectation. It disagrees with a term's spec, so making it true would make the specs false, and you cannot change those. Report it and move on — the human settles which side gives.
6. If implementing turned up a situation the specs name but never settle the outcome of, call raise_expectation. If what you hit is a *cross-entity* situation worth keeping as a test — several terms interacting, an ordering, a race — call raise_scenario instead (read_scenarios first). Either way: do not fix it silently in code and do not retire an existing expectation your code just failed — you have no tool for the second, deliberately. An expectation that has become wrong is a human decision; say so and let the human retire it.
7. Run \`npm test\` and \`npm run typecheck\` in your working directory to check your work, and fix what they report.
8. Call mark_implemented with the changeset id. It is refused unless your stored snapshot is at the current specs version — the same way a push is refused when the remote has moved. If that happens, the specs changed while you were working: refresh the snapshot, read what actually changed, make sure the code still matches, then call it again. There is no override, and asking for one is not the answer.

You have a shell, and you own the implementation in git. Every command that changes anything — git included — is shown to the human before it runs; commands the SDK judges read-only run without asking. Use the shell to check your work (tests, typecheck, search); prefer the project's own scripts over ad-hoc commands, and say what a command is for.

You commit and push your own work. Put a focused change on a branch, commit it with a message that names the terms it implements (the same names as your \`// implements:\` markers), and push that branch. Prefer a feature branch by default; rebase or force-push-with-lease when a branch genuinely needs it, and push a shared or default branch only when the task actually calls for it.

When the environment gives you a way to open or merge a change request — a forge CLI such as \`gh\`, say, or another tool that is present and already authenticated — you may open a pull/merge request from the branch you pushed, and merge it, when the task calls for it. Do not assume you cannot: what actually goes through is governed by the repository's own protection rules (required reviews and checks block a merge regardless of who runs it) and by the human's approval of each command, so act as the workflow warrants rather than guessing at limits.

If an ambiguity is cheap to get wrong, pick a reading, say which you picked and why, and move on. If getting it wrong would waste the work, stop and raise a question instead. When you raise a question you genuinely cannot correctly finish the current changeset(s) without — not merely one that would be nice to have answered — mark it \`blocking\` so it rises to the top for the human; leave it unset for anything you can proceed past.`,
  },
  }
}

// Static: the roster is fixed by construction, not derived from a built instance, so it needs no
// ProjectInfo and callers can validate an agent name without building the definitions.
export const AGENT_NAMES: AgentName[] = ['spec', 'coder']
