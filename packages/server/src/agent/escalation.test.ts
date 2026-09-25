import { describe, expect, it } from 'vitest'
import {
  answerProposalNotice,
  answerProposalPrompt,
  isRaiseTool,
  specProactiveEnabled,
  triageNotice,
  triagePrompt,
} from './escalation.js'

describe('escalation helpers (GH #137)', () => {
  it('recognises the raise tools, and nothing else', () => {
    for (const t of ['raise_question', 'raise_expectation', 'raise_scenario']) expect(isRaiseTool(t)).toBe(true)
    for (const t of ['propose_changeset', 'read_glossary', 'mark_implemented', 'Bash', 'export_specs']) {
      expect(isRaiseTool(t)).toBe(false)
    }
  })

  it('is off unless SPEC_PROACTIVE is 1/true', () => {
    expect(specProactiveEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(specProactiveEnabled({ SPEC_PROACTIVE: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(specProactiveEnabled({ SPEC_PROACTIVE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(specProactiveEnabled({ SPEC_PROACTIVE: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })

  it('summarises a run’s raises with pluralisation and "and"', () => {
    expect(triageNotice(['raise_question'])).toContain('1 question')
    expect(triagePrompt(['raise_question', 'raise_question'])).toContain('2 questions')
    const mixed = triagePrompt(['raise_question', 'raise_scenario', 'raise_scenario'])
    expect(mixed).toContain('1 question and 2 scenarios')
  })

  it('instructs @spec to propose/sharpen but never decide, and to read the raised items', () => {
    const p = triagePrompt(['raise_expectation'])
    expect(p).toContain('read_expectations')
    expect(p).toContain('propose a changeset')
    expect(p).toContain('Never decide a product fork')
  })
})

describe('answer-wake helpers (GH #150)', () => {
  it('names the question and reflects a chosen option in the prompt', () => {
    const p = answerProposalPrompt({ id: 'q-001', chose: 'Hybrid', note: 'go with the hybrid model' })
    expect(p).toContain('q-001')
    expect(p).toContain('chose "Hybrid"')
    expect(p).toContain('go with the hybrid model')
    expect(p).toContain('read_questions')
    expect(p).toContain('propose the changeset')
  })

  it('handles a prose answer (no option chosen) without inventing a choice', () => {
    const p = answerProposalPrompt({ id: 'q-002', chose: null, note: '' })
    expect(p).toContain('q-002')
    expect(p).toContain('in prose without taking one of the options')
    expect(p).not.toContain('chose "')
  })

  it('keeps @spec propose-only — a proposal changes nothing until applied', () => {
    const p = answerProposalPrompt({ id: 'q-003', chose: 'Yes', note: '' })
    expect(p).toContain('a proposal changes nothing until a human applies it')
  })

  it('the notice is attributed-style and names the question', () => {
    expect(answerProposalNotice({ id: 'q-007', chose: 'Yes', note: '' })).toContain('q-007')
  })
})
