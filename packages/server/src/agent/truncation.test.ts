import { describe, expect, it } from 'vitest'
import { MAX_TOKEN_CONTINUATIONS, afterResult, truncationExhaustedNotice } from './truncation.js'

describe('afterResult (GH #156)', () => {
  it('treats a natural end (or any non-max_tokens stop) as done', () => {
    expect(afterResult({ subtype: 'success', stopReason: 'end_turn', continuationsUsed: 0 })).toBe('done')
    expect(afterResult({ subtype: 'success', stopReason: null, continuationsUsed: 0 })).toBe('done')
    expect(afterResult({ subtype: 'success', stopReason: 'tool_use', continuationsUsed: 0 })).toBe('done')
  })

  it('does not continue when the turn ended in error, even if stop_reason somehow says max_tokens', () => {
    expect(afterResult({ subtype: 'error_during_execution', stopReason: 'max_tokens', continuationsUsed: 0 })).toBe('done')
  })

  it('continues a max_tokens cutoff while there is budget, then reports exhausted', () => {
    expect(afterResult({ subtype: 'success', stopReason: 'max_tokens', continuationsUsed: 0 })).toBe('continue')
    expect(afterResult({ subtype: 'success', stopReason: 'max_tokens', continuationsUsed: MAX_TOKEN_CONTINUATIONS - 1 })).toBe('continue')
    expect(afterResult({ subtype: 'success', stopReason: 'max_tokens', continuationsUsed: MAX_TOKEN_CONTINUATIONS })).toBe('exhausted')
  })

  it('is bounded — it never returns continue past the cap, so the loop cannot run forever', () => {
    for (let used = MAX_TOKEN_CONTINUATIONS; used < MAX_TOKEN_CONTINUATIONS + 5; used += 1) {
      expect(afterResult({ subtype: 'success', stopReason: 'max_tokens', continuationsUsed: used })).toBe('exhausted')
    }
  })

  it('pluralises the exhausted notice and names the count', () => {
    expect(truncationExhaustedNotice(1)).toContain('1 automatic continuation.')
    expect(truncationExhaustedNotice(3)).toContain('3 automatic continuations')
    expect(truncationExhaustedNotice(3)).toMatch(/cut off at the output limit/i)
  })
})
