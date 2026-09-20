# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is long and carries the reasoning behind most of what follows. Read the relevant
section of it before changing anything structural — nearly every design choice here has a
stated "and here is why the obvious alternative is wrong" attached.

## Commands

```bash
npm install                    # root workspaces (packages/core, packages/server, packages/web)

npm run dev                    # spec tool, unsandboxed: express :5174 + vite :5173
npm run dev:sandbox            # same, with express and @coder in containers + vite on host
                               #   @coder has no project to point at yet — see "The consumer project" below

npm test                       # unit: core, server, web, cli (each a separate vitest run)
npm run typecheck              # tsc across core, server, web, cli

npm run test:integration       # e2e: the spectra bin in a throwaway HOME (install + init + up)
npm run test:integration:docker#   the same, in a clean container (test/integration/)

npm run sandbox:logs           # docker compose logs -f
npm run sandbox:down           # docker compose down
```

Single test file / single test name (vitest per workspace, so target the workspace first):

```bash
npm test -w @abseed/spectra-core -- src/changeset.test.ts
npm test -w @abseed/spectra-server -- -t 'refuses when the snapshot is behind'
```

There is no linter or formatter configured. `npm run typecheck` and the tests are the whole gate.

## Spectra is the tool; the consumer project is separate

This repo is **Spectra** — the spec tool (`packages/core`, `packages/server`, `packages/web`): a
glossary of Terms in `specs/*.json`, edited only through structured changesets, plus a chat dock
running two agents.

**The engine ships empty** — like a database with no data, it carries no glossary of its own.
The ToDo glossary this repo grew up around now lives at `examples/todo/specs/` as a *sample to
point at*, not content baked into the tool. `npm run dev` sets `SPECS_DIR` to it; run the server
with `SPECS_DIR` unset and it operates on an empty glossary (the default is a gitignored
`.dev/specs` scratch dir). A configured install will supply the path later, via the CLI/link
layer.

There used to be a second half in `app/` — a ToDo app written *from* `specs/terms/`, the output
side of the loop. It has been **sidelined** to the `backup/todo-app` branch (a full snapshot,
incl. `app/`), because Spectra ships as the tool and the *consumer project it implements into is
a separate thing* — kept elsewhere, or external. The removal was clean because `app/` was
standalone-by-construction (its own `node_modules`/`tsconfig`, never an npm workspace).

### The consumer project (the target @coder implements into)

`@coder`'s working directory and only mount is the project it implements into, at
**`/work/project`** in the container (`APP_DIR` in `packages/runtime/src/main.ts`, overridable).
An installed run gets the repo mounted there by `spectra init`; this dev `docker-compose.yml`
has no consumer project, so it mounts a placeholder `./app` at `/work/project` and `@coder` is
**inert in dev** until a real project is configured (a bare `docker compose up` still creates an
empty `./app` on the host). The in-process (unsandboxed) coder's cwd is `APP_DIR` in
`packages/server/src/agent/agents.ts` (`CODER_DIR` env, default `<repo>/app`).

`@spec` is code-blind by default (`builtins: []`). Opt-in (GH #136): set `SPEC_CODE_DIR` and `@spec`
gains **read-only** code access there (`Read`/`Glob`/`Grep` only, that dir as its cwd) — for surfacing
specs from an existing repo (brownfield) and checking the glossary against the code. Unset ⇒ unchanged.
A sandboxed/attached deployment supplies this as a read-only mount (that plumbing is a later slice);
in-process, it points at a checkout on disk. Reference tools (GH #145): `SPEC_WEB_FETCH=1` /
`SPEC_WEB_SEARCH=1` grant `@spec` `WebFetch` / `WebSearch` (auto-approved; propose-only, so still
human-gated). All off by default; a hosted deployment gates each with a per-project toggle instead.

The *drift check* that used to be copied into `app/` (`specs.snapshot.json` + `implements.test.ts`)
now ships as the **`@abseed/spectra-drift-check`** package (`packages/drift-check`): a consumer project adds
it as a dev-dependency and writes a one-line test — `driftCheck({ srcDir, snapshotPath })` — against
its committed `specs.snapshot.json` (which `@coder` writes with `export_specs`). It stays offline and
standalone (the package reads files, needs no coordinator), which is what lets the check run in a bare
copy of the project and inside `@coder`'s sandbox alike. `@coder` still reads a snapshot at
`APP_DIR/specs.snapshot.json` (reported on `/health`) and degrades to "no snapshot" when absent. The
rest of the tool (glossary, changesets, `@spec`, MCP, version guard) is unaffected and its tests pass.

The design principle to preserve when that project is wired back: the consumer project stays
**standalone** — its own `node_modules`/`tsconfig`, buildable in a bare copy — which is what
lets the sandbox mount it and nothing else. Do not fold it into the root workspaces. It has
never heard of `specs/` at runtime; the only link is a human or `@coder` editing it to match.

## The write path, and why it is shaped this way

The glossary is only ever written by the server, through `commit.ts`. Three rules hold it up,
and each is enforced by construction rather than by a prompt asking nicely:

- **Changesets only.** No direct term editor exists in the UI, and `@spec` has `builtins: []`
  — no filesystem tools at all, so it *cannot* bypass the rule.
- **Which tools each agent gets is decided server-side**, in `packages/server/src/agent/agents.ts`.
  That file is the single definition of who `@spec` and `@coder` are: prompt, builtins,
  auto-approvals, tool list. The sandboxed container fetches it from `/mcp/coder/profile` at
  the start of every run rather than carrying its own copy, so an attacker inside the box
  cannot edit the definition that decides.
- **Written files match the hand-authored format** — fixed key order, one line per attribute
  (`serializeTerm` in `commit.ts`). Break this and every applied changeset reformats the files
  it touches and buries the real diff.

`packages/server/src/store.ts` is the only module that reads the filesystem, and every read goes back to
disk — the files are the source of truth and may have been hand-edited between two requests.
A file that fails to parse becomes a `problem` in the response, never an exception.

The changeset engine lives in `shared/`, not the server, because the web app uses it to
*preview* what a changeset would do and the server uses the identical code to *commit*. One
set of rules, so the preview cannot disagree with the result.

## The snapshot and the version check

The *protocol* below lives in the tool (`packages/server/src/specsExport.ts`, `GET /api/specs/version`,
`mark_implemented`) and is unaffected by the app removal. The two concrete files it names —
`specs.snapshot.json` and `implements.test.ts` — lived in the sidelined `app/` (still on
`backup/todo-app`) and live in whatever consumer project `@coder` implements into — the one you
supply at `spectra init` time via `--dir`, not something bundled in the tool. The
snapshot fallback path (`packages/server/src/specsExport.ts`, `APP_SNAPSHOT`) now points at an absent
file and degrades to "no readable snapshot" rather than crashing. Read the rest as describing
how the guard works against *whatever* project holds the snapshot.

`specs.snapshot.json` is the glossary contract as a committed file — names, kinds, and a hash of
each term's spec/parent/attributes. The project's `implements.test.ts` checks the
`// implements: termName` markers against it, which is what makes the drift check work both in a
bare copy of the project and inside a sandbox that cannot see `specs/`.

The staleness guard is modelled on `git push`:

| git | here |
|---|---|
| remote `HEAD` | `specsVersion` — what `specs/` is at now |
| local ref | `version` inside the committed snapshot |
| `git fetch` | `export_specs`, then writing the file |
| non-fast-forward reject | `mark_implemented` refused on mismatch |

Consequences worth knowing before touching any of it:

- **The snapshot has no timestamp, on purpose.** It is a pure function of the specs, so
  re-exporting when nothing changed leaves it byte-identical. Adding a `generatedAt` would
  dirty it every export and bury the signal.
- **Reads are never refused, only `mark_implemented`.** Reading current specs while holding an
  old snapshot is harmless and often the point.
- **The refusal names versions, never a path.** The spec tool must not know where the
  implementer keeps its code — `app/specs.snapshot.json` is this repo's arrangement, not part
  of the protocol.
- **No version argument and no `force`.** An agent that supplied its own version could export,
  never write the file, and pass on the second try.

Expose versions both sides can compare, not a `stale: true` the server computed. `GET
/api/specs/version` reports both numbers and offers no verdict.

## Sandbox

`docker-compose.yml` puts `server` on two networks and the agent runtimes (`coder`, `spec`) on one
`internal: true` network with no route out. The project at `/work/project` is `coder`'s only mount
(`spec` has none). Each runtime reaches the model through express's `/anthropic` proxy and the
glossary through `/mcp/<agent>`, holding the literal string `proxied-by-the-spec-tool` instead of a
credential, and reaches the server as `SERVER_URL`. (The compose service was renamed `spec`→`server`
so the `spec` name is free for the @spec runtime; the runner relays each agent to its URL —
`CODER_URL`/`SPEC_URL` on the server — or runs it in-process when unset. `AGENT` selects which agent a
runtime is; the image is shared, `Dockerfile.runtime`.)

- The `/anthropic` proxy is mounted **before `express.json()`** in `packages/server/src/index.ts`, and
  that ordering is load-bearing — a JSON parser upstream would consume the body stream.
- `/mcp` is deliberately outside `/api`: it is the sandbox's surface, not the UI's.
- **Port 5174 collides silently.** Docker publishes by DNAT, so a host server already on 5174
  wins with no bind conflict to notice. The tell is `GET /api/sandbox` reporting
  `configured: false`. Run `npm run dev:sandbox`, not `npm run dev`, with the containers up.
- **Switching between `docker-compose.yml` and `docker-compose.open.yml` recreates the
  network**, and a merely *restarted* container comes back without its DNS aliases — `spec`
  then fails to resolve from `coder`, which looks exactly like the service being down. Use
  `docker compose down` before switching, never `restart`.
- **There is no unsandboxed fallback.** If `CODER_URL` is set and the container is down, the
  turn does not run. An *unset* `CODER_URL` is the different, deliberate choice that plain
  `npm run dev` makes.
- **For `Bash` the SDK classifies the command itself** and lets ones it judges read-only
  through without an approval card. The card covers commands that *change* things — do not
  write prompts or docs claiming every command is shown.

## Agent-SDK traps already paid for

- **Credentials are not interchangeable.** `sk-ant-api…` → `ANTHROPIC_API_KEY`;
  `sk-ant-oat…` (from `claude setup-token`) → `CLAUDE_CODE_OAUTH_TOKEN`. The wrong pairing
  loads fine, reports "agent ready", then fails every call with `Invalid API key`. The server
  checks the prefix on boot.
- **Deeply nested zod defeats the SDK's JSON-Schema conversion, silently** — and takes down
  the *entire* MCP server, so the agent reports having no tools at all with nothing in any
  log. Tool boundaries use flat op shapes with an enum tag; the real schema validates before
  anything reaches disk. Do not reuse `shared/`'s discriminated unions in a tool signature.
- **`settingSources: []` is deliberate.** Without it the SDK inherits the machine's Claude Code
  settings and the agents pick up whatever MCP servers the user has configured globally.
- **A tool named bare in `allowedTools` never reaches the permission callback**, so listing a
  write there silently disables its approval card.
- **zod versions differ on purpose**: `shared/` is on zod 3, `server/` on zod 4 (what the SDK
  needs). The compose file mounts `/stack/server/node_modules` from the image for exactly this
  reason — do not let a host `node_modules` shadow it.

## Conventions

- **Every file opens with a doc comment explaining *why*, not what.** This is the dominant
  style in the repo and it carries real decisions — read it before editing, and extend it
  rather than stripping it.
- **`app/src/domain/*.ts` quote the spec text they implement** in the header comment, and cite
  the question id that settled any ambiguity (`q-002`, `q-004`). Keep doing this; it is what
  makes a spec change traceable to the code that needs updating.
- **`// implements: termName`** — comma-separated bare identifiers, nothing else. Trailing
  prose fails `implements.test.ts`; put it on the next line.
- **`// verifies: e-nnn`** — on the *test* that exercises an expectation; comma-separated
  expectation ids, prose on the next line. The counterpart of `// implements:` for expectations:
  the drift check (`@abseed/spectra-drift-check`) flags a functional expectation no test verifies,
  and a marker naming an expectation the glossary dropped. Non-functional expectations need none.
- Term filenames are kebab-cased from the term name (`RecurringTask` → `recurring-task.json`),
  via `termFileName` in `commit.ts`.
- **Questions, not findings.** If something an implementation pass discovers cannot be phrased
  as a question a human answers, it does not belong in `specs/questions/`. A question's
  `because` must quote the spec text in conflict — "this was awkward to implement" is not
  grounds to change a spec.
- Answers are written back into the question file and are not editable. Change a decision by
  raising a new question.

## Where things live

Code lives under `packages/` (`core`, `agent-tools`, `drift-check`, `server`, `web`, `cli`, `runtime`);
all but `runtime` are npm workspaces under the `@abseed/spectra-*` scope, `runtime` is standalone (its own lockfile, the
sandbox image builds from it). The engine ships with **no glossary** — the example one lives
under `examples/todo/specs/`. Neither the glossary nor runtime data defaults into the source
tree: an unconfigured run reads specs from a gitignored `.dev/specs` and writes data under the
XDG data home (`~/.local/share/spectra`). `npm run dev` overrides both to `examples/todo/specs`
and a gitignored `.dev/` scratch dir.

```
examples/todo/specs/terms/*.json      source of truth, hand-editable (the example glossary)
examples/todo/specs/project.json      the glossary's identity (name, domain) — via SpecStore.projectInfo()
examples/todo/specs/changesets/       pending; applied/ and rejected/ are the history
examples/todo/specs/questions/        what the glossary does not settle, and what was decided
packages/core/src/                    the engine — types, valueType grammar, backlinks, conflicts, changeset ops
packages/server/src/agent/agents.ts   the single definition of who @spec and @coder are
packages/server/src/agent/runner.ts   runs a turn, streams it, blocks on approvals
packages/server/src/agent/implementationScheduler.ts  GH #133: debounces applied changesets into one @coder turn (fires only into an unattended session); seam + in-process timer
packages/server/src/agent/escalation.ts  GH #137: a @coder run that raised questions/expectations/scenarios wakes @spec to triage (propose/sharpen, never decide); opt-in via SPEC_PROACTIVE
packages/server/src/agent/tools.ts    domain tools; mcpHttp.ts is the same tools over HTTP
packages/server/src/specsExport.ts    the snapshot + version (README calls this glossaryExport.ts)
packages/server/src/commit.ts         the only writer of specs/
packages/core/src/specStore.ts        the storage seam (interface) — the stable public boundary a
                                      backend implements; lives in core so implementors need no server deps
packages/core/src/transcriptStore.ts  the transcript seam (interface) — same, for chat history
packages/server/src/fileSystemSpecStore.ts  FS backend — (root, projectId) → <root>/<project_id>/specs
packages/server/src/sqlSpecStore.ts   SQL backend (node:sqlite) — (db, projectId), one DB many projects
packages/server/src/storeFactory.ts   builds a built-in store (fs|sql) from a StoreChoice
packages/server/src/backend.ts        the storage plugin boundary: SPEC_STORE=fs|sql, or a module
                                      specifier the server imports (SpecStoreBackend) — bring-your-own store
packages/runtime/src/main.ts            the sandboxed half of @coder (implements into /work/project, mounted by `spectra init --dir`)
packages/cli/src/commands.ts          the CLI grammar: argv -> docker compose argv (pure, tested)
packages/cli/src/cli.ts               the CLI entry — resolves the compose file, shells out to docker
packages/drift-check/src/             @abseed/spectra-drift-check — the offline glossary↔code drift check a consumer project depends on
~/.local/share/spectra/transcripts.db chat history — XDG data home (dev: .dev/data); prunable, never the record
```

The consumer project (`app/`, holding `specs.snapshot.json` and the `implements` drift check)
was sidelined to the `backup/todo-app` branch — see "Spectra is the tool" above.

Ports: **5173** spec tool UI — Vite in dev, or the `web` container (nginx, `Dockerfile.web`)
in the containerized/installed path; **5174** its API (serves no HTML — a 404 in the browser
is correct), **5177** the coder container. (5175 was the ToDo app's dev server, now on
`backup/todo-app`.)

The three pieces each have a container: `Dockerfile.spec` (server), `Dockerfile.runtime`
(sandbox), `Dockerfile.web` (nginx serving the built UI, proxying `/api` to `spec`). The `web`
service is behind a compose **profile** so plain `docker compose up` (what `dev:sandbox` runs)
leaves it out and its 5173 does not collide with host Vite — start it explicitly with
`docker compose up web`.

There are two compose files. `docker-compose.yml` is the **contributors'** file — services build
from the working tree (`context: .`). `default.yaml` is the **distribution** file — services build
from a *remote git context pinned to a release* (`context: github…#${SPECTRA_REF}`), so an install
needs neither a clone nor a registry, just this file (this is SAL's model: a compose template
fetched from a pinned release, used verbatim). `default.yaml` is only the shared *base*: the
project-specific bits — `SPECS_DIR`, data persistence, and @coder's mount — come from a per-project
override that `spectra init` writes, layered with `-f default.yaml -f <project>.yaml`. Keep the two
files in structural sync; they differ only in build context and in that the project mounts live in
the override.

`packages/cli` (`@abseed/spectra-cli`) wraps this compose. Two shapes: per-component
`spectra <server|spec|coder|web> up|down|restart|status|logs`, and whole-stack `spectra up|down|build [component]`.
Each maps to the matching `docker compose` call — component names now match services one-to-one
(`server` the coordinator, `spec`/`coder` the agent runtimes, `web` the UI), and anything touching
`web` carries `--profile web`. Verbs are up/down (not start/stop) to match compose; per-component
`down` is `rm -sf <svc>` (that one service), whole-stack `down` is the project teardown. There is no
`install`: `up` builds a missing image on its own, and `build` is only for pre-build/rebuild.
`--compose-file` repeats to layer a base and an override (`-f default.yaml -f <project>.yaml`) — the
seam `spectra init` uses. The argv→compose translation is a pure function (`commands.ts`), fully
tested without a docker daemon; `--dry-run` prints the command it would run.

A third shape, `spectra attach`, is the odd one out: it does *not* drive the local stack. It runs
only the two agent runtimes (`attach.yaml`) pointed at a **remote** coordinator — the hosted, dial-out
counterpart of `spectra up`. The laptop is behind NAT, so `MODE=attach` dials one WebSocket *out*
(`COORDINATOR_URL=.../api/relay/runtime`); the coordinator drives the agents on your machine and the
runtime calls the model directly (consumer-pays), reaching the glossary over `/mcp` at `SERVER_URL`
(the coordinator's origin, derived from `--coordinator`). `@coder` keeps its container boundary — the
whole reason attach runs in docker rather than as a bare process — but on an egress-*ful* network,
the one deliberate difference from the sandbox. It is cloud-agnostic on purpose: it names a
coordinator URL, never a specific host. Flags (`--coordinator`, `--project`, `--token`, `--org`,
`--server`, `--dir`, `--agent coder|spec|both`) fall back to env (`COORDINATOR_URL`, `PROJECT_ID`,
`DEVICE_TOKEN`, `ORG`); the model credential rides in from `spectra.env` like the rest. Parsing and
resolution are pure (`parseAttachArgs`/`resolveAttach`/`attachComposeArgv`); `--dry-run` prints the
compose command plus the resolved env (token masked). Like `docker-compose.yml`/`default.yaml`, attach
has two files kept in structural sync: `attach.yaml` (contributors', `context: .`) and
`attach.default.yaml` (distribution, remote git context) — the latter ships as a release asset and
`install.sh` places it at `~/.config/spectra/attach.yaml`, which `attachComposeFile()` prefers over the
repo's when present, so the installed CLI's `attach` builds from a pinned release with no checkout.

`spectra login` / `spectra logout` fetch (or drop) the device token `attach` needs, so it can omit
`--token`. login is a browser loopback flow (`login.ts`): it starts a localhost server, opens the
browser to the coordinator's `/api/auth/cli/start`, the signed-in user approves, the coordinator
redirects a one-time **code** back to that localhost server, and the CLI exchanges the code — server
to server — for a device token (the code, never the token, rides through the browser). Tokens are
saved `0600` under `~/.config/spectra/credentials.json`, **keyed by coordinator origin** (`credentials.ts`),
so dev and prod tokens coexist and `attach` reads the right one (flag > `DEVICE_TOKEN` > stored). This
is cloud-agnostic — the coordinator serves those `/api/auth/cli/*` endpoints; the CLI just names a URL.

`spectra projects` lists the projects reachable on a coordinator (device-token authed, `GET
/api/cli/projects`) so a `--project` id need not be looked up by hand. `attach` and `projects` share
`resolveCoordinator`: an explicit `--coordinator`/`COORDINATOR_URL` wins, else the sole saved login,
else an error — so once you're logged into one coordinator, the flag is optional on both.

`spectra init --name … --domain …` links a repo to a project (`init.ts`, pure `planInit`). It writes
three things in three places, per the corrected model above: `.spectra/config.json` in the repo (the
*link* — project id + identity + optional Server URL), the **server-side** glossary's `project.json`
under the XDG data home (`~/.local/share/spectra/projects/<id>/specs/` — the glossary is the Server's,
never the repo), and a per-project compose override under `~/.config/spectra/projects/<id>/` (mounts
that glossary + data into `spec`, and the repo — `--dir` for a subdir — into `coder` at `/work/project`).
Projects are keyed by **id**, not folder path. `--name`/`--domain` default to the repo folder name.

Compose-file resolution (`discovery.ts`, pure `resolveComposeFiles`) then makes `spectra up` inside an
inited repo need no `-f`: explicit `--compose-file` flags win, else `SPECTRA_COMPOSE_FILE`, else it
walks up for `.spectra/config.json` and layers `default.yaml` + that project's override, else falls
back to the repo's `docker-compose.yml` (the contributors' file). The sandboxed `@coder` implements
into `/work/project` (`APP_DIR` in `packages/runtime/src/main.ts`), which `spectra init --dir` mounts
the chosen repo at; the in-process (unsandboxed) coder used by plain `npm run dev` takes its cwd from
`CODER_DIR` instead (`packages/server/src/agent/agents.ts`).

Distribution (like SAL: build in CI, download prebuilt in the installer):
- `npm run build -w @abseed/spectra-cli` (`scripts/build.mjs`) esbuild-bundles the CLI to a single
  dependency-free `packages/cli/dist/cli.mjs` that runs on plain `node` (version inlined via a
  `define`; no `tsx` at runtime). `dist/` is gitignored. **The git tag is the source of truth for a
  release's version**: `release.yml` passes `SPECTRA_VERSION=${tag#v}` to the build, so tag `v0.5.0`
  ships a bundle reporting `0.5.0` with no `package.json` bump to keep in sync. `packages/cli`'s
  `version` is only the fallback for a local/dev build. So cutting a release is just `git tag vX && push`.
- `.github/workflows/release.yml` runs that build on a `v*` tag and attaches the bundle (as
  `spectra`), `default.yaml`, and `SHASUMS256.txt` to the GitHub release.
- `install.sh` (repo root) **downloads** those release assets (checksum-verified), installs the bin
  at `~/.local/bin/spectra`, and scaffolds `~/.config/spectra/default.yaml` — which is why discovery
  prefers the installed `default.yaml`. It never clones or builds; `SPECTRA_ASSETS=<dir>` installs
  from local prebuilt assets instead of downloading (the test path).

The npm **libraries** (`@abseed/spectra-core`, `-agent-tools`, `-drift-check`, `-web-lib`) publish on
a separate tag-driven flow — one tag per package, `<name>-v<version>` — via `publish.yml` (Trusted
Publishing/OIDC, no token). The tag's version must match `packages/<name>/package.json` or the job
fails, so the recipe is bump-and-merge, then tag. `npm run release:lib -- <name>` is the guarded
helper: it reads the version, checks you are on a clean, in-sync `main`, and dry-runs unless given
`--push`. See the "Releasing" section in `README.md`.

The **consumer's credential** goes in `~/.config/spectra/spectra.env` (one shared file, not per-project;
`spectra init` scaffolds it 0600 with the two credential lines commented and never overwrites it). The
CLI hands it to compose with `--env-file` when it exists, so the compose files' `${ANTHROPIC_API_KEY}` /
`${CLAUDE_CODE_OAUTH_TOKEN}` resolve without a shell export (a real export still overrides it). The
credential reaches only the `spec` container, never an image. This is the *consumer* path — a contributor
running `npm run dev` uses the repo-root `.env` (`packages/server/src/env.ts`) instead; do not conflate them.

Run in dev without installing via `npm run spectra -w @abseed/spectra-cli -- up`. `npm run
test:install:docker` builds the assets once (a builder stage, as CI does) then installs and
exercises the prebuilt bin. The download path itself needs a published release (push a `v*` tag).

Re-running the implementation pass is not a command. It is a directed ask: point at
`specs/terms/` and update the consumer project to match, using the `// implements:` markers to
target it — against whatever project you point `@coder` at (`spectra init --dir`).
