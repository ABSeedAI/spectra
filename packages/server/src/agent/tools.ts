/**
 * The server's tool surface: the pure tools from `@abseed/spectra-agent-tools`, plus the three that can
 * only run on the host, composed into the set an agent actually gets.
 *
 * The pure tools (reads, propose_changeset, raise_question) moved into `@abseed/spectra-agent-tools` so the
 * hosted coordinator can serve them too. The three here stay because each reaches something a Worker
 * has not got: `raise_expectation` runs a model-backed check (the agent SDK), and `mark_implemented`
 * / `export_specs` read and write the committed specs snapshot on disk. They are defined in the same
 * `ToolDef` shape and appended to the pure set, so from the agent's side there is one flat tool list.
 *
 * `toolsFor` is unchanged from a caller's view — same signature, same `mcp__blueprints__` names — so
 * the runner and the MCP HTTP route need no change. The version stamp every result carries is now
 * injected (`withVersion`): here it is read from the filesystem snapshot via `currentSnapshot`.
 */
import { z } from 'zod'
import { defineTool, pick, pureTools, qualified, say, withVersion } from '@abseed/spectra-agent-tools'
import type { ToolDef } from '@abseed/spectra-agent-tools'
import type { Author, SpecStore, TranscriptStore } from '@abseed/spectra-core'
import { markImplemented } from '@abseed/spectra-core'
import { checkExpectation } from '../expectationCheck.js'
import { currentSnapshot, deployedVersion, recordExport } from '../specsExport.js'
import { raiseExpectation } from '@abseed/spectra-core'

export { qualified }

/**
 * The three host-coupled tools. Kept out of `@abseed/spectra-agent-tools` because each depends on something
 * a Worker does not have — a model call, or the filesystem snapshot.
 */
function hostTools(store: SpecStore, author: Author): ToolDef[] {
  /**
   * The second write that needs no approval, and for the same reason as `raise_question`: it cannot
   * change what the app does. The worst an expectation can do is turn a check red, which surfaces a
   * defect rather than concealing one. There is deliberately no tool for retiring one — that stays a
   * human act, over the HTTP route.
   */
  const raiseExpectationTool = defineTool(
    'raise_expectation',
    [
      'Record something someone should be able to expect. Use this when you notice a scenario the specs name but never settle the outcome of — especially one turned up by using or implementing the thing rather than reading it.',
      'It changes nothing and needs no approval: the most it can do is make a check go red.',
      'A functional expectation must be phrased using only glossary vocabulary — term names, attributes, function names. If you cannot write it without naming a button, a screen or a string in the UI, it is not an expectation about the domain and does not belong here.',
      'A non-functional one describes a property of a running build — responsiveness, persistence, accessibility — and is exempt from that rule.',
      'An invariant is a property of the domain that must ALWAYS hold, not a single case — "a stock transfer conserves total quantity", "an account balance never goes negative", "the sum of ledger entries equals the balance". Use it (not functional) when the rule is universal rather than a given/when/then scenario; like functional ones it must name the terms it constrains.',
      'This is not a question. If the outcome turns on a product decision nobody has made, raise a question instead; an expectation asserts what should happen, so writing one is claiming the answer is already settled.',
      'Check read_expectations first — a near-duplicate is worse than nothing, because two statements of the same rule drift apart.',
      'What you write is read against the glossary before it lands. If it clashes with a spec it is still recorded, with the clash attached, and it will not count as coverage until a human settles which side gives — so read the findings that come back and say what they were.',
    ].join(' '),
    {
      kind: z.enum(['functional', 'non-functional', 'invariant']),
      terms: z
        .array(z.string())
        .describe('Glossary terms this concerns. Name every term involved — coverage is computed from this, so an expectation about an interaction must name both ends.'),
      given: z.string().optional().describe('The situation, if it is conditional'),
      expect: z.string().describe('What must hold'),
      pass: z.string().describe('What was being done when it came up, e.g. "implementation" or "usage"'),
      from: z.string().optional().describe('Question or changeset id this follows from, if any'),
      file: z.string().optional(),
    },
    async (args) => {
      const draft = { kind: args.kind, terms: args.terms, given: args.given ?? '', expect: args.expect }

      // Checked on the way in, the same as the UI's gate. Not a refusal: an agent that noticed a real
      // disagreement should still be able to record it, and a tool that silently discarded the finding
      // would leave the write looking clean — which is the failure this whole field exists to prevent.
      const [{ terms }, { expectations }] = await Promise.all([store.readTerms(), store.readExpectations()])
      const report = await checkExpectation(draft, terms, expectations)

      const outcome = await raiseExpectation(
        store,
        { ...draft, pass: args.pass, from: args.from, file: args.file, contested: report.findings },
        author,
      )

      return say(
        outcome.ok
          ? {
              raised: outcome.id,
              file: `specs/expectations/${outcome.file}`,
              ...(report.findings.length > 0
                ? {
                    contested: report.findings,
                    note: 'Recorded, but it clashes with what the glossary already says. It will not count as coverage until a human settles which side gives. Do not implement it and do not change the specs to match it — report the clash and stop.',
                  }
                : { note: 'Live immediately. Cite this id in the test that proves it.' }),
            }
          : { error: outcome.error },
      )
    },
  )

  /**
   * The one refusal, and it is git's non-fast-forward reject. `mark_implemented` is a claim: code
   * exists matching this changeset. If the snapshot stored alongside that code predates the change,
   * nothing can verify the claim — so it is refused rather than recorded. No version argument and no
   * force, deliberately: the version is read from the artifact, never supplied.
   */
  const markImplementedTool = defineTool(
    'mark_implemented',
    'Record that code has been written for an applied changeset. Call this only after the code actually matches what the changeset says — it is what stops the change showing as outstanding work in the UI. Refused unless your stored specs snapshot is at the current version, since otherwise the code was written against a contract that has since moved.',
    { id: z.string().describe('The applied changeset id, e.g. "cs-001"') },
    async (args) => {
      const current = (await currentSnapshot(store)).version
      const deployed = await deployedVersion()

      if (deployed === null) {
        return say({
          refused: 'You have no readable specs snapshot, so this claim cannot be checked.',
          specsVersion: current,
          fix: 'Call export_specs, store the result the way your project expects, then try again.',
        })
      }
      if (deployed !== current) {
        return say({
          refused: 'The specs have moved since your snapshot was taken, so this claim cannot be checked.',
          snapshotVersion: deployed,
          specsVersion: current,
          fix: 'Call export_specs and store the result. Then read_glossary for what actually changed — the snapshot names which terms moved, not what they now say — and confirm the code still matches before calling this again.',
        })
      }

      const outcome = await markImplemented(store, args.id, new Date().toISOString())
      return say(outcome.ok ? { marked: args.id, file: outcome.file } : { error: outcome.error })
    },
  )

  const exportSpecsTool = defineTool(
    'export_specs',
    'Fetch the specs contract at its current version. Store the returned JSON verbatim wherever your project keeps it, and commit it with the code: it is what lets the code be checked against the specs offline, and its version is what mark_implemented is checked against. Refresh it before an implementation pass. It carries names, kinds and hashes, not spec text — it tells you *which* terms moved, and read_glossary tells you what they now say. Do not hand-edit it.',
    {},
    async () => {
      const snapshot = await currentSnapshot(store)
      recordExport(snapshot, new Date().toISOString())
      return say(snapshot)
    },
    { readOnlyHint: true },
  )

  return [raiseExpectationTool, markImplementedTool, exportSpecsTool]
}

/**
 * The subset a given agent may call, resolved from its definition — the pure tools plus the host
 * ones, stamped with the current version, filtered to the agent's names.
 *
 * `author` is the agent's own identity, passed by the caller — the runner and the HTTP MCP route both
 * know which agent this is and stamp it here. It is never taken from the tool arguments, so a write
 * the agent makes is attributed to the agent, not to whatever it claims.
 */
export function toolsFor(
  store: SpecStore,
  transcripts: TranscriptStore,
  author: Author,
  names: readonly string[],
): ToolDef[] {
  const versionOf = async () => (await currentSnapshot(store)).version
  const all = [...pureTools(store, transcripts, author), ...hostTools(store, author)]
  return pick(withVersion(all, versionOf), names)
}
