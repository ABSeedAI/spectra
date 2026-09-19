/**
 * Runtime validation for files a human may have edited by hand. The goal is a
 * readable message pointing at the offending field, never a stack trace.
 */
import { z } from 'zod'
import { TERM_TYPES } from './types.js'
import type { Changeset, Expectation, ProjectInfo, Question, Scenario, Term } from './types.js'
import { describeValueTypeError, isValueType } from './valueType.js'

const termName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a bare identifier (letters, digits, underscore)')

const valueType = z.string().superRefine((raw, ctx) => {
  if (!isValueType(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: describeValueTypeError(raw) })
  }
})

/** Identity, stamped server-side. `.strict()` schemas below must allow it or a record carrying it is rejected. */
const authorSchema = z
  .object({
    kind: z.enum(['human', 'spec', 'coder']),
    user: z.string().min(1).optional(),
  })
  .strict()

/** Project identity, hand-editable in `specs/project.json`. Both fields are required and non-empty. */
export const projectInfoSchema = z
  .object({
    name: z.string().min(1),
    domain: z.string().min(1),
  })
  .strict()

export const attributeSchema = z
  .object({
    name: z.string().min(1),
    valueType,
    default: z.unknown().optional(),
    optional: z.boolean().optional(),
  })
  .strict()

export const termSchema = z
  .object({
    name: termName,
    type: z.enum(TERM_TYPES as unknown as [string, ...string[]]),
    spec: z.string(),
    parent: termName.nullable().default(null),
    tags: z.array(z.string()).default([]),
    attributes: z.array(attributeSchema).default([]),
  })
  .strict()

const opSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add_entity'),
      term: termName,
      termType: z.enum(TERM_TYPES as unknown as [string, ...string[]]).optional(),
      parent: termName.nullable().optional(),
      spec: z.string(),
      tags: z.array(z.string()).optional(),
      attributes: z.array(attributeSchema).optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove_entity'), term: termName }).strict(),
  z.object({ op: z.literal('add_attribute'), term: termName, attribute: attributeSchema }).strict(),
  z
    .object({ op: z.literal('remove_attribute'), term: termName, attribute: z.string().min(1) })
    .strict(),
  z.object({ op: z.literal('modify_spec'), term: termName, spec: z.string() }).strict(),
])

export const changesetSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string(),
    ops: z.array(opSchema),
    tests: z.array(z.string()).default([]),
    fromQuestion: z.string().min(1).optional(),
    appliedAt: z.string().optional(),
    implementedAt: z.string().nullable().optional(),
    author: authorSchema.optional(),
  })
  .strict()

export const proposalSchema = z
  .object({
    summary: z.string(),
    ops: z.array(opSchema),
    tests: z.array(z.string()).default([]),
  })
  .strict()

export const questionSchema = z
  .object({
    id: z.string().min(1),
    asks: z.string().min(1),
    because: z.string().min(1),
    raisedBy: z
      .object({
        pass: z.string().min(1),
        file: z.string().optional(),
        terms: z.array(termName).default([]),
      })
      .strict(),
    options: z
      .array(
        z
          .object({
            label: z.string().min(1),
            detail: z.string().optional(),
            proposal: proposalSchema.nullable().default(null),
          })
          .strict(),
      )
      .default([]),
    author: authorSchema.optional(),
    status: z.enum(['draft', 'ready']).default('ready'),
    rev: z.number().int().positive().default(1),
    answer: z
      .object({
        chose: z.string().nullable(),
        note: z.string(),
        answeredAt: z.string(),
        changesetId: z.string().optional(),
        author: authorSchema.optional(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((question, ctx) => {
    // An answer naming an option that does not exist would silently lose the decision.
    const chose = question.answer?.chose
    if (chose && !question.options.some((option) => option.label === chose)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer', 'chose'],
        message: `no option labelled "${chose}"`,
      })
    }
  })

export const expectationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['functional', 'non-functional', 'invariant']),
    author: authorSchema.optional(),
    status: z.enum(['draft', 'ready']).default('ready'),
    rev: z.number().int().positive().default(1),
    terms: z.array(termName).default([]),
    given: z.string().default(''),
    expect: z.string().min(1),
    raisedBy: z
      .object({
        pass: z.string().min(1),
        from: z.string().min(1).optional(),
        file: z.string().optional(),
      })
      .strict(),
    supersededBy: z.string().min(1).nullable().default(null),
    retiredBecause: z.string().min(1).optional(),
    contested: z
      .array(
        z
          .object({
            kind: z.enum(['unknown-term', 'duplicate', 'overlaps', 'contradicts', 'restates']),
            subject: z.string().min(1),
            detail: z.string().min(1),
            quote: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((expectation, ctx) => {
    // A functional or invariant expectation with no terms names nothing in the vocabulary — it would
    // sit in the file and constrain nothing. Both are phrased in glossary terms, so both must name at
    // least one. Non-functional ones are exempt: "the app survives a refresh" legitimately scopes to
    // no term at all.
    if ((expectation.kind === 'functional' || expectation.kind === 'invariant') && expectation.terms.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terms'],
        message: `a ${expectation.kind} expectation must name at least one glossary term`,
      })
    }
    // Self-supersession would make the expectation both live and retired, and the coverage
    // pass would have to pick one.
    if (expectation.supersededBy === expectation.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: 'an expectation cannot supersede itself',
      })
    }
  })

/**
 * A Scenario (see {@link Scenario}). `.strict()` like the rest; the one rule is that it must name a
 * term — a scenario is cross-entity by definition, so an empty `terms` is almost always a mistake.
 * `expect` requires at least one assertion (a scenario that asserts nothing proves nothing).
 */
export const scenarioSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    author: authorSchema.optional(),
    terms: z.array(termName).default([]),
    given: z.string().default(''),
    steps: z.array(z.string().min(1)).default([]),
    expect: z.array(z.string().min(1)).min(1),
    raisedBy: z
      .object({
        pass: z.string().min(1),
        from: z.string().min(1).optional(),
        file: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (scenario.terms.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terms'],
        message: 'a scenario must name at least one glossary term',
      })
    }
  })

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}

export function parseTerm(data: unknown): ParseResult<Term> {
  const result = termSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Term }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseChangeset(data: unknown): ParseResult<Changeset> {
  const result = changesetSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Changeset }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseQuestion(data: unknown): ParseResult<Question> {
  const result = questionSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Question }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseExpectation(data: unknown): ParseResult<Expectation> {
  const result = expectationSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Expectation }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseScenario(data: unknown): ParseResult<Scenario> {
  const result = scenarioSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Scenario }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseProjectInfo(data: unknown): ParseResult<ProjectInfo> {
  const result = projectInfoSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as ProjectInfo }
    : { ok: false, errors: formatIssues(result.error) }
}
