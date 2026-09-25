/**
 * The SQL backing for the glossary — a peer of {@link FileSystemSpecStore} behind {@link SpecStore}.
 *
 * This is the second implementation the interface was built for: the same contract, backed by a
 * table per collection instead of a directory. It is what lets the glossary live somewhere a team
 * (and later a hosted, multi-tenant deployment) can reach — the filesystem impl serves a single
 * local checkout; this one serves a database, and the D1 target reuses the same SQL.
 *
 * **One database, many projects.** The filesystem impl gets away with "one directory = one project"
 * because a directory *is* the partition. A central DB is the opposite point: it holds every
 * project's glossary at once — a solo dev's several projects, and later many tenants' — so every
 * collection row carries a `project_id`, and a store instance is **scoped to one project** (its
 * `projectId`). Which project a request is for is resolved above this, at the composition root.
 *
 * The two principles the interface named, made concrete here:
 *   - **State is data, not location.** Where the FS impl moves a file into `applied/` or `retired/`,
 *     this sets a `status` / `lifecycle` column. The partitioned reads are the same query, filtered.
 *   - **Records are addressed by domain id** — except that a *changeset id is not unique across
 *     history: the same `chat-001` can be pending and also applied (twice, if applied in two partial
 *     passes). So changesets use a surrogate `row_id` PK with a partial unique index enforcing one
 *     *pending* per id, exactly the invariant the FS impl gets from one file in `changesets/`.
 *     Terms/questions/expectations are one record per id, so `(project_id, id)` is their key.
 *
 * `commitApplication` is a real transaction (the reconcile + the pending→applied move commit or roll
 * back together), and rev/CAS is *enforced* — a conditional `UPDATE … WHERE rev = ?` that touches no
 * rows is the conflict — where the FS impl is best-effort. `node:sqlite` is synchronous; the async
 * signatures wrap sync calls, and `:memory:` makes the store trivially testable.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  glossaryVersion,
  parseChangeset,
  parseExpectation,
  parseProjectInfo,
  parseQuestion,
  parseScenario,
  parseTerm,
} from '@abseed/spectra-core'
import type {
  Answer,
  Changeset,
  Expectation,
  ProjectInfo,
  Question,
  QuestionOption,
  Scenario,
  SourceProblem,
  Term,
} from '@abseed/spectra-core'
import type {
  CommitApplication,
  CommitConflict,
  CommitResult,
  ExpectationFeed,
  Glossary,
  MutationResult,
  PendingChangesets,
  QuestionFeed,
  ScenarioFeed,
  SpecStore,
  StoredAt,
} from '@abseed/spectra-core'

/** Same neutral default as the FS impl — an unconfigured glossary must not borrow another's name. */
const FALLBACK_PROJECT_INFO: ProjectInfo = {
  name: 'Untitled project',
  domain: 'a shared glossary',
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  brief TEXT
);
CREATE TABLE IF NOT EXISTS terms (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS changesets (
  row_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,               -- domain id (chat-001); NOT unique across history
  status TEXT NOT NULL,           -- pending | applied | rejected
  json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS changesets_one_pending
  ON changesets(project_id, id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS questions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1, -- optimistic-concurrency counter, enforced below
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS expectations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,        -- live | retired  (draft/ready is inside the record's own status)
  rev INTEGER NOT NULL DEFAULT 1,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS scenarios (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,               -- s-001; add-only in v1 (no lifecycle/rev yet)
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
`

interface JsonRow {
  json: string
}

/** Parse the last number out of an id like `chat-004` / `q-012` / `e-3`; -1 if it has none. */
function idNumber(id: string): number {
  const match = /(\d+)\D*$/.exec(id)
  return match ? Number(match[1]) : -1
}

export class SqlSpecStore implements SpecStore {
  private readonly db: DatabaseSync
  private readonly projectId: string

  /**
   * `file` is a path or `:memory:` (like TranscriptStore); `projectId` scopes every read and write.
   * The project is registered with a neutral identity if new — the "ship empty" state — which
   * `setProjectInfo` names later; this also keeps the collections' `project_id` foreign key valid.
   */
  constructor(file: string, projectId: string) {
    this.projectId = projectId
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    // Migrate a projects table created before the System Brief (GH #143): add the column if absent.
    // CREATE TABLE IF NOT EXISTS never alters an existing table, so this is the one-way add.
    const cols = this.db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'brief')) this.db.exec('ALTER TABLE projects ADD COLUMN brief TEXT')
    this.db
      .prepare('INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)')
      .run(projectId, FALLBACK_PROJECT_INFO.name, FALLBACK_PROJECT_INFO.domain)
  }

  /**
   * Every project in the database — the cross-project read the per-instance store cannot do, since
   * it is bound to one project. A deployment-level query (the picker asks it), so it is static: opens
   * its own connection, ensures the schema (an untouched db has no `projects` table yet), lists.
   */
  static listProjects(file: string): Array<{ id: string; name: string; domain: string }> {
    const db = new DatabaseSync(file)
    try {
      db.exec(SCHEMA)
      return db.prepare('SELECT id, name, domain FROM projects ORDER BY id').all() as Array<{
        id: string
        name: string
        domain: string
      }>
    } finally {
      db.close()
    }
  }

  close(): void {
    this.db.close()
  }

  /** Run `fn` inside a transaction; roll back on any throw. Used where several writes must land as one. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── Project identity ─────────────────────────────────────────────────────────────────

  async projectInfo(): Promise<ProjectInfo> {
    const row = this.db.prepare('SELECT name, domain, brief FROM projects WHERE id = ?').get(this.projectId) as
      | { name: string; domain: string; brief: string | null }
      | undefined
    if (!row) return FALLBACK_PROJECT_INFO
    const parsed = parseProjectInfo({ name: row.name, domain: row.domain, ...(row.brief ? { brief: row.brief } : {}) })
    return parsed.ok ? parsed.value : FALLBACK_PROJECT_INFO
  }

  /**
   * Name this project. Not part of {@link SpecStore} — the FS impl gets identity from a file a
   * human or `spectra init` writes; here it updates the project's row (created at construction).
   */
  setProjectInfo(info: ProjectInfo): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, domain, brief) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain, brief = excluded.brief`,
      )
      .run(this.projectId, info.name, info.domain, info.brief ?? null)
  }

  async setProjectBrief(brief: string): Promise<void> {
    // Empty/whitespace clears it (stored NULL), so an un-briefed project reads exactly as before.
    this.db
      .prepare('UPDATE projects SET brief = ? WHERE id = ?')
      .run(brief.trim() ? brief : null, this.projectId)
  }

  // ── Low-level ────────────────────────────────────────────────────────────────────────

  /** Every query is scoped to this project, so projectId is always the first bound parameter. */
  private rows(sql: string, ...params: Array<string | number>): JsonRow[] {
    return this.db.prepare(sql).all(this.projectId, ...params) as unknown as JsonRow[]
  }

  /**
   * Parse each row's JSON with a domain parser, collecting parse failures as `problems` rather than
   * throwing — the same graceful degradation the FS reads give. In practice the store only ever
   * writes valid JSON, so `problems` is empty; the path exists because the interface keeps it.
   */
  private parseRows<T>(
    rows: JsonRow[],
    parse: (data: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): { values: T[]; problems: SourceProblem[] } {
    const values: T[] = []
    const problems: SourceProblem[] = []
    for (const row of rows) {
      let data: unknown
      try {
        data = JSON.parse(row.json)
      } catch (error) {
        problems.push({ file: '(row)', message: `invalid JSON — ${(error as Error).message}` })
        continue
      }
      const parsed = parse(data)
      if (parsed.ok) values.push(parsed.value)
      else {
        const id = data && typeof data === 'object' ? String((data as { id?: string }).id ?? '(row)') : '(row)'
        problems.push({ file: id, message: parsed.errors.join('; ') })
      }
    }
    return { values, problems }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────

  async readTerms(): Promise<Glossary> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM terms WHERE project_id = ?'), parseTerm)
    values.sort((a, b) => a.name.localeCompare(b.name))
    return { terms: values, problems }
  }

  async readChangesets(): Promise<PendingChangesets> {
    const pending = this.parseRows(this.rows("SELECT json FROM changesets WHERE project_id = ? AND status = 'pending'"), parseChangeset)
    const applied = this.parseRows(this.rows("SELECT json FROM changesets WHERE project_id = ? AND status = 'applied'"), parseChangeset)
    const rejected = this.parseRows(this.rows("SELECT json FROM changesets WHERE project_id = ? AND status = 'rejected'"), parseChangeset)
    const byAppliedDesc = (a: Changeset, b: Changeset) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? '')
    return {
      changesets: pending.values,
      problems: pending.problems,
      applied: applied.values.sort(byAppliedDesc),
      rejected: rejected.values.sort(byAppliedDesc),
    }
  }

  async readQuestions(): Promise<QuestionFeed> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM questions WHERE project_id = ?'), parseQuestion)
    return { questions: values, problems }
  }

  async readExpectations(): Promise<ExpectationFeed> {
    const live = this.parseRows(this.rows("SELECT json FROM expectations WHERE project_id = ? AND lifecycle = 'live'"), parseExpectation)
    const retired = this.parseRows(this.rows("SELECT json FROM expectations WHERE project_id = ? AND lifecycle = 'retired'"), parseExpectation)
    live.values.sort((a, b) => a.id.localeCompare(b.id))
    retired.values.sort((a, b) => a.id.localeCompare(b.id))
    // Drafts share the live lifecycle with published ones — status is data. Absent status = ready.
    return {
      expectations: live.values.filter((e) => e.status !== 'draft'),
      drafts: live.values.filter((e) => e.status === 'draft'),
      retired: retired.values,
      problems: live.problems,
    }
  }

  async readScenarios(): Promise<ScenarioFeed> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM scenarios WHERE project_id = ?'), parseScenario)
    values.sort((a, b) => a.id.localeCompare(b.id))
    return { scenarios: values, problems }
  }

  /** The pending changeset with this id — the FS impl's `findChangesetEntry` reads `changesets/` too. */
  async findChangeset(id: string): Promise<Changeset | null> {
    const row = this.db
      .prepare("SELECT json FROM changesets WHERE project_id = ? AND id = ? AND status = 'pending'")
      .get(this.projectId, id) as JsonRow | undefined
    if (!row) return null
    const parsed = parseChangeset(JSON.parse(row.json))
    return parsed.ok ? parsed.value : null
  }

  private findKeyed<T>(
    table: string,
    id: string,
    parse: (data: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): T | null {
    const row = this.db
      .prepare(`SELECT json FROM ${table} WHERE project_id = ? AND id = ?`)
      .get(this.projectId, id) as JsonRow | undefined
    if (!row) return null
    const parsed = parse(JSON.parse(row.json))
    return parsed.ok ? parsed.value : null
  }

  async findQuestion(id: string): Promise<Question | null> {
    return this.findKeyed('questions', id, parseQuestion)
  }

  async findExpectation(id: string): Promise<Expectation | null> {
    return this.findKeyed('expectations', id, parseExpectation)
  }

  async findScenario(id: string): Promise<Scenario | null> {
    return this.findKeyed('scenarios', id, parseScenario)
  }

  // ── Id allocation ──────────────────────────────────────────────────────────────────
  // A `SELECT max` over the whole table for this project, including resolved/retired rows, so an id
  // is never handed out twice — the SQL analogue of the FS impl counting every partition directory.

  private nextId(prefix: string, table: string): string {
    const ids = (
      this.db.prepare(`SELECT id FROM ${table} WHERE project_id = ?`).all(this.projectId) as unknown as Array<{ id: string }>
    ).map((r) => r.id)
    const highest = ids.reduce((max, id) => Math.max(max, idNumber(id)), 0)
    return `${prefix}-${String(highest + 1).padStart(3, '0')}`
  }

  async nextChangesetId(): Promise<string> {
    return this.nextId('chat', 'changesets')
  }
  async nextQuestionId(): Promise<string> {
    return this.nextId('q', 'questions')
  }
  async nextExpectationId(): Promise<string> {
    return this.nextId('e', 'expectations')
  }
  async nextScenarioId(): Promise<string> {
    return this.nextId('s', 'scenarios')
  }

  // ── Simple creates ───────────────────────────────────────────────────────────────────

  async addChangeset(changeset: Changeset): Promise<StoredAt> {
    this.db
      .prepare("INSERT INTO changesets (project_id, id, status, json) VALUES (?, ?, 'pending', ?)")
      .run(this.projectId, changeset.id, JSON.stringify(changeset))
    return changeset.id
  }

  async addQuestion(question: Question): Promise<StoredAt> {
    this.db
      .prepare('INSERT INTO questions (project_id, id, rev, json) VALUES (?, ?, ?, ?)')
      .run(this.projectId, question.id, question.rev ?? 1, JSON.stringify(question))
    return question.id
  }

  async addExpectation(expectation: Expectation): Promise<StoredAt> {
    this.db
      .prepare("INSERT INTO expectations (project_id, id, lifecycle, rev, json) VALUES (?, ?, 'live', ?, ?)")
      .run(this.projectId, expectation.id, expectation.rev ?? 1, JSON.stringify(expectation))
    return expectation.id
  }

  async addScenario(scenario: Scenario): Promise<StoredAt> {
    this.db
      .prepare('INSERT INTO scenarios (project_id, id, json) VALUES (?, ?, ?)')
      .run(this.projectId, scenario.id, JSON.stringify(scenario))
    return scenario.id
  }

  // ── State transitions ────────────────────────────────────────────────────────────────

  /** Atomic: reconcile terms to the post-image and move the changeset pending → applied. */
  async commitApplication(application: CommitApplication): Promise<CommitResult | CommitConflict> {
    return this.tx(() => {
      const written: string[] = []
      const deleted: string[] = []

      const existing = new Map<string, string>()
      for (const row of this.db.prepare('SELECT name, json FROM terms WHERE project_id = ?').all(this.projectId) as unknown as Array<{ name: string; json: string }>) {
        existing.set(row.name, row.json)
      }

      // Optimistic concurrency (GH #93): compare-and-swap on the glossary version, inside the same
      // transaction as the write, so the check and the write are atomic — no window for a concurrent
      // apply to slip between. Returning here commits an empty (no-op) transaction; nothing is written.
      if (application.baseVersion !== undefined) {
        const currentVersion = glossaryVersion([...existing.values()].map((json) => JSON.parse(json) as Term))
        if (currentVersion !== application.baseVersion) return { conflict: true, currentVersion }
      }

      const upsert = this.db.prepare(
        'INSERT INTO terms (project_id, name, json) VALUES (?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET json = excluded.json',
      )
      for (const term of application.nextTerms) {
        const json = JSON.stringify(term)
        if (existing.get(term.name) === json) continue // unchanged
        upsert.run(this.projectId, term.name, json)
        written.push(term.name)
      }

      const survived = new Set(application.nextTerms.map((term) => term.name))
      for (const name of existing.keys()) {
        if (survived.has(name)) continue
        this.db.prepare('DELETE FROM terms WHERE project_id = ? AND name = ?').run(this.projectId, name)
        deleted.push(name)
      }

      const pending = this.db
        .prepare("SELECT row_id, json FROM changesets WHERE project_id = ? AND id = ? AND status = 'pending'")
        .get(this.projectId, application.changesetId) as { row_id: number; json: string } | undefined
      if (!pending) throw new Error(`No pending changeset with id "${application.changesetId}".`)
      const changeset = parseChangeset(JSON.parse(pending.json))
      if (!changeset.ok) throw new Error(`Pending changeset "${application.changesetId}" will not parse.`)

      // The applied record is a distinct row (a changeset applied in two passes appears twice —
      // the interface's "honest count"). `implementedAt: null` marks landed-but-not-coded.
      const applied = this.db
        .prepare("INSERT INTO changesets (project_id, id, status, json) VALUES (?, ?, 'applied', ?)")
        .run(
          this.projectId,
          application.changesetId,
          JSON.stringify({ ...changeset.value, ops: application.appliedOps, appliedAt: application.appliedAt, implementedAt: null }),
        )

      if (application.remainingOps.length === 0) {
        this.db.prepare('DELETE FROM changesets WHERE row_id = ?').run(pending.row_id)
      } else {
        this.db
          .prepare('UPDATE changesets SET json = ? WHERE row_id = ?')
          .run(JSON.stringify({ ...changeset.value, ops: application.remainingOps }), pending.row_id)
      }

      return { written, deleted, resolvedTo: `applied:${application.changesetId}#${applied.lastInsertRowid}` }
    })
  }

  /** Move a pending changeset to rejected — terminal, so it flips status in place. Null if none pending. */
  async rejectChangeset(id: string): Promise<string | null> {
    const result = this.db
      .prepare("UPDATE changesets SET status = 'rejected' WHERE project_id = ? AND id = ? AND status = 'pending'")
      .run(this.projectId, id)
    return result.changes > 0 ? `rejected:${id}` : null
  }

  /** Record code written against an applied changeset — sets implementedAt on the (first) applied row. */
  async markImplemented(id: string, at: string): Promise<StoredAt | null> {
    const row = this.db
      .prepare("SELECT row_id, json FROM changesets WHERE project_id = ? AND id = ? AND status = 'applied' ORDER BY row_id LIMIT 1")
      .get(this.projectId, id) as { row_id: number; json: string } | undefined
    if (!row) return null
    const parsed = parseChangeset(JSON.parse(row.json))
    if (!parsed.ok) return null
    this.db
      .prepare('UPDATE changesets SET json = ? WHERE row_id = ?')
      .run(JSON.stringify({ ...parsed.value, implementedAt: at }), row.row_id)
    return `applied:${id}#${row.row_id}`
  }

  // Optimistic concurrency, ENFORCED: read the current rev, refuse a stale expectedRev, then write
  // with `WHERE rev = <read>` so a concurrent bump between the two makes the UPDATE touch no rows —
  // which is the conflict. (The FS impl does the same check without the atomic guard.)
  private guard(currentRev: number, expectedRev: number | undefined): { ok: true; next: number } | { ok: false; currentRev: number } {
    if (expectedRev !== undefined && expectedRev !== currentRev) return { ok: false, currentRev }
    return { ok: true, next: currentRev + 1 }
  }

  async writeAnswer(questionId: string, answer: Answer, expectedRev?: number): Promise<MutationResult> {
    const row = this.db.prepare('SELECT rev, json FROM questions WHERE project_id = ? AND id = ?').get(this.projectId, questionId) as
      | { rev: number; json: string }
      | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    const g = this.guard(row.rev, expectedRev)
    if (!g.ok) return { ok: false, reason: 'conflict', currentRev: g.currentRev }

    const question = JSON.parse(row.json)
    const result = this.db
      .prepare('UPDATE questions SET json = ?, rev = ? WHERE project_id = ? AND id = ? AND rev = ?')
      .run(JSON.stringify({ ...question, answer, rev: g.next }), g.next, this.projectId, questionId, row.rev)
    if (result.changes === 0) return { ok: false, reason: 'conflict', currentRev: this.revOf('questions', questionId) }
    return { ok: true, rev: g.next, at: questionId }
  }

  async setQuestionBlocking(questionId: string, blocking: boolean, expectedRev?: number): Promise<MutationResult> {
    const row = this.db.prepare('SELECT rev, json FROM questions WHERE project_id = ? AND id = ?').get(this.projectId, questionId) as
      | { rev: number; json: string }
      | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    const g = this.guard(row.rev, expectedRev)
    if (!g.ok) return { ok: false, reason: 'conflict', currentRev: g.currentRev }

    // Kept off the record when false — a cleared flag reads exactly as an un-flagged question.
    const question = JSON.parse(row.json)
    if (blocking) question.blocking = true
    else delete question.blocking
    const result = this.db
      .prepare('UPDATE questions SET json = ?, rev = ? WHERE project_id = ? AND id = ? AND rev = ?')
      .run(JSON.stringify({ ...question, rev: g.next }), g.next, this.projectId, questionId, row.rev)
    if (result.changes === 0) return { ok: false, reason: 'conflict', currentRev: this.revOf('questions', questionId) }
    return { ok: true, rev: g.next, at: questionId }
  }

  async updateQuestionOptions(questionId: string, options: QuestionOption[], expectedRev?: number): Promise<MutationResult> {
    const row = this.db.prepare('SELECT rev, json FROM questions WHERE project_id = ? AND id = ?').get(this.projectId, questionId) as
      | { rev: number; json: string }
      | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    const g = this.guard(row.rev, expectedRev)
    if (!g.ok) return { ok: false, reason: 'conflict', currentRev: g.currentRev }

    const question = JSON.parse(row.json)
    const result = this.db
      .prepare('UPDATE questions SET json = ?, rev = ? WHERE project_id = ? AND id = ? AND rev = ?')
      .run(JSON.stringify({ ...question, options, rev: g.next }), g.next, this.projectId, questionId, row.rev)
    if (result.changes === 0) return { ok: false, reason: 'conflict', currentRev: this.revOf('questions', questionId) }
    return { ok: true, rev: g.next, at: questionId }
  }

  async retireExpectation(id: string, retired: Expectation, expectedRev?: number): Promise<MutationResult> {
    const row = this.db
      .prepare("SELECT rev FROM expectations WHERE project_id = ? AND id = ? AND lifecycle = 'live'")
      .get(this.projectId, id) as { rev: number } | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    const g = this.guard(row.rev, expectedRev)
    if (!g.ok) return { ok: false, reason: 'conflict', currentRev: g.currentRev }

    const result = this.db
      .prepare("UPDATE expectations SET lifecycle = 'retired', json = ?, rev = ? WHERE project_id = ? AND id = ? AND lifecycle = 'live' AND rev = ?")
      .run(JSON.stringify({ ...retired, rev: g.next }), g.next, this.projectId, id, row.rev)
    if (result.changes === 0) return { ok: false, reason: 'conflict', currentRev: this.revOf('expectations', id) }
    return { ok: true, rev: g.next, at: id }
  }

  async rewriteExpectation(expectation: Expectation, expectedRev?: number): Promise<MutationResult> {
    const row = this.db
      .prepare("SELECT rev FROM expectations WHERE project_id = ? AND id = ? AND lifecycle = 'live'")
      .get(this.projectId, expectation.id) as { rev: number } | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    const g = this.guard(row.rev, expectedRev)
    if (!g.ok) return { ok: false, reason: 'conflict', currentRev: g.currentRev }

    const result = this.db
      .prepare("UPDATE expectations SET json = ?, rev = ? WHERE project_id = ? AND id = ? AND lifecycle = 'live' AND rev = ?")
      .run(JSON.stringify({ ...expectation, rev: g.next }), g.next, this.projectId, expectation.id, row.rev)
    if (result.changes === 0) return { ok: false, reason: 'conflict', currentRev: this.revOf('expectations', expectation.id) }
    return { ok: true, rev: g.next, at: expectation.id }
  }

  private revOf(table: string, id: string): number {
    const row = this.db.prepare(`SELECT rev FROM ${table} WHERE project_id = ? AND id = ?`).get(this.projectId, id) as
      | { rev: number }
      | undefined
    return row?.rev ?? 1
  }
}
