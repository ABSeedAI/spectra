/**
 * The translation is the CLI's whole job, so it is tested exhaustively here — parsing an argv
 * tail into an intent, and mapping a command onto the docker compose argv. No docker is needed
 * (that is the point of keeping the builders pure); the runner in cli.ts is the only part that
 * touches a real daemon, and it is deliberately thin.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPONENTS,
  VERBS,
  attachComposeArgv,
  attachEnv,
  composeArgv,
  composeBuildArgv,
  composeStackArgv,
  coordinatorOrigin,
  deriveServerUrl,
  orgForProject,
  relayUrl,
  parseArgs,
  parseAttachArgs,
  parseLoginArgs,
  parseLogoutArgs,
  parseProjectsArgs,
  resolveAttach,
} from './commands.js'

const BASE = '/repo/docker-compose.yml'
const OVERRIDE = '/cfg/project.yml'
const ATTACH = '/repo/attach.yaml'

/** A parsed attach intent, for feeding resolveAttach in tests. */
function attach(flags: Record<string, string>, agent: 'coder' | 'spec' | 'both' = 'both') {
  return { kind: 'attach' as const, flags, agent, dryRun: false, build: false, composeFiles: [] }
}

describe('coordinatorOrigin', () => {
  it('normalizes every scheme (and a bare host) to the same https origin', () => {
    for (const input of [
      'https://c.example',
      'wss://c.example',
      'wss://c.example/api/relay/runtime',
      'c.example',
      'https://c.example/some/path?q=1',
    ]) {
      expect(coordinatorOrigin(input)).toBe('https://c.example')
    }
  })

  it('maps ws/http to an http origin', () => {
    expect(coordinatorOrigin('ws://localhost:8787')).toBe('http://localhost:8787')
    expect(coordinatorOrigin('http://localhost:8787/x')).toBe('http://localhost:8787')
  })

  it('trims and returns null for junk', () => {
    expect(coordinatorOrigin('  https://c.example  ')).toBe('https://c.example')
    expect(coordinatorOrigin('')).toBeNull()
    expect(coordinatorOrigin('not a url')).toBeNull()
  })
})

describe('relayUrl', () => {
  it('derives the relay path (so nobody types /api/relay/runtime)', () => {
    expect(relayUrl('https://c.example')).toBe('wss://c.example/api/relay/runtime')
    expect(relayUrl('http://localhost:8787')).toBe('ws://localhost:8787/api/relay/runtime')
  })

  it('round-trips: a bare-origin login still yields a valid relay URL', () => {
    const origin = coordinatorOrigin('wss://dev.example')! // what the old bare login stored
    expect(relayUrl(origin)).toBe('wss://dev.example/api/relay/runtime')
    expect(deriveServerUrl(relayUrl(origin))).toBe('https://dev.example')
  })
})

describe('composeArgv (per component)', () => {
  it('maps server -> the server service, with up/down/restart/status/logs', () => {
    expect(composeArgv('server', 'up', [BASE])).toEqual(['-f', BASE, 'up', '-d', 'server'])
    expect(composeArgv('server', 'down', [BASE])).toEqual(['-f', BASE, 'rm', '-sf', 'server'])
    expect(composeArgv('server', 'restart', [BASE])).toEqual(['-f', BASE, 'restart', 'server'])
    expect(composeArgv('server', 'status', [BASE])).toEqual(['-f', BASE, 'ps', 'server'])
    expect(composeArgv('server', 'logs', [BASE])).toEqual(['-f', BASE, 'logs', '-f', 'server'])
  })

  it('carries --profile web for the profiled web service', () => {
    expect(composeArgv('web', 'up', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'up', '-d', 'web'])
    expect(composeArgv('web', 'down', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'rm', '-sf', 'web'])
  })

  it('does not add a profile for non-profiled services', () => {
    expect(composeArgv('coder', 'restart', [BASE])).toEqual(['-f', BASE, 'restart', 'coder'])
  })

  it('layers multiple compose files in order (base then override)', () => {
    expect(composeArgv('server', 'up', [BASE, OVERRIDE])).toEqual([
      '-f', BASE, '-f', OVERRIDE, 'up', '-d', 'server',
    ])
  })

  it('produces a valid command for every component/verb pair', () => {
    for (const component of COMPONENTS) {
      for (const verb of VERBS) {
        const argv = composeArgv(component, verb, [BASE])
        expect(argv.slice(0, 2)).toEqual(['-f', BASE])
        expect(argv.length).toBeGreaterThan(2)
      }
    }
  })
})

describe('composeStackArgv (whole stack)', () => {
  it('brings the whole stack up with the web profile enabled', () => {
    expect(composeStackArgv('up', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'up', '-d'])
  })
  it('tears it all down without a profile (down ignores profiles)', () => {
    expect(composeStackArgv('down', [BASE])).toEqual(['-f', BASE, 'down'])
  })
  it('layers base + override', () => {
    expect(composeStackArgv('up', [BASE, OVERRIDE])).toEqual([
      '-f', BASE, '-f', OVERRIDE, '--profile', 'web', 'up', '-d',
    ])
  })
})

describe('composeBuildArgv', () => {
  it('builds everything (web profile enabled) when no component is named', () => {
    expect(composeBuildArgv(undefined, [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'build'])
  })
  it('builds a single service (server -> the server service)', () => {
    expect(composeBuildArgv('server', [BASE])).toEqual(['-f', BASE, 'build', 'server'])
  })
  it('carries the web profile when building web', () => {
    expect(composeBuildArgv('web', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'build', 'web'])
  })
})

describe('parseArgs', () => {
  it('parses a component + verb into a run intent', () => {
    expect(parseArgs(['server', 'up'])).toEqual({
      kind: 'run',
      component: 'server',
      verb: 'up',
      dryRun: false,
      composeFiles: [],
    })
  })

  it('collects repeated --compose-file, in order', () => {
    expect(parseArgs(['server', 'up', '--compose-file', BASE, '--compose-file', OVERRIDE])).toMatchObject({
      kind: 'run',
      composeFiles: [BASE, OVERRIDE],
    })
  })

  it('picks up --dry-run in any position', () => {
    expect(parseArgs(['--dry-run', 'web', 'logs'])).toMatchObject({ kind: 'run', dryRun: true })
  })

  it('treats no args and -h/--help as help; -v/--version as version', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' })
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' })
  })

  it('parses whole-stack up/down', () => {
    expect(parseArgs(['up'])).toMatchObject({ kind: 'stack', action: 'up' })
    expect(parseArgs(['down', '--dry-run'])).toMatchObject({ kind: 'stack', action: 'down', dryRun: true })
  })

  it('errors when up/down is given a stray argument', () => {
    expect(parseArgs(['up', 'server'])).toMatchObject({ kind: 'error' })
  })

  it('parses build with no component, with "all", and with a component', () => {
    expect(parseArgs(['build'])).toMatchObject({ kind: 'build', component: undefined })
    expect(parseArgs(['build', 'all'])).toMatchObject({ kind: 'build', component: undefined })
    expect(parseArgs(['build', 'web'])).toMatchObject({ kind: 'build', component: 'web' })
  })

  it('errors on unknown component, verb, build target, option, and stray positional', () => {
    expect(parseArgs(['nope', 'up'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'fly'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['build', 'nope'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'up', '--wat'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'up', 'extra'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'up', '--compose-file'])).toMatchObject({ kind: 'error' })
  })
})

describe('--env-file (the shared credential file)', () => {
  const ENV = '/cfg/spectra/spectra.env'

  it('prepends --env-file before the compose files when one is passed', () => {
    expect(composeArgv('server', 'up', [BASE], ENV)).toEqual([
      '--env-file', ENV, '-f', BASE, 'up', '-d', 'server',
    ])
    expect(composeStackArgv('up', [BASE, OVERRIDE], ENV)).toEqual([
      '--env-file', ENV, '-f', BASE, '-f', OVERRIDE, '--profile', 'web', 'up', '-d',
    ])
    expect(composeBuildArgv(undefined, [BASE], ENV)).toEqual([
      '--env-file', ENV, '-f', BASE, '--profile', 'web', 'build',
    ])
  })

  it('omits --env-file when there is no credential file', () => {
    expect(composeArgv('server', 'up', [BASE])).not.toContain('--env-file')
    expect(composeStackArgv('down', [BASE])).not.toContain('--env-file')
    expect(composeBuildArgv('coder', [BASE])).not.toContain('--env-file')
  })
})

describe('spectra attach', () => {
  describe('parseAttachArgs', () => {
    it('collects flags, agent, and compose overrides', () => {
      const parsed = parseAttachArgs([
        '--coordinator', 'wss://h/api/relay/runtime', '--project', 'p1', '--org', 'acme',
        '--token', 't', '--dir', '/w', '--server', 'https://h', '--agent', 'coder',
        '--compose-file', ATTACH, '--dry-run',
      ])
      expect(parsed).toEqual({
        kind: 'attach',
        flags: { coordinator: 'wss://h/api/relay/runtime', project: 'p1', org: 'acme', token: 't', dir: '/w', server: 'https://h' },
        agent: 'coder',
        dryRun: true,
        build: false,
        composeFiles: [ATTACH],
      })
    })

    it('parses --build, and --ref implies build', () => {
      expect(parseAttachArgs(['--project', 'p', '--build'])).toMatchObject({ kind: 'attach', build: true })
      const withRef = parseAttachArgs(['--project', 'p', '--ref', 'v0.8.0'])
      expect(withRef).toMatchObject({ kind: 'attach', build: true, flags: { ref: 'v0.8.0' } })
      expect(parseAttachArgs(['--project', 'p'])).toMatchObject({ build: false })
    })

    it('defaults to both agents and no dry-run', () => {
      const parsed = parseAttachArgs(['--coordinator', 'wss://h/r', '--project', 'p'])
      expect(parsed).toMatchObject({ kind: 'attach', agent: 'both', dryRun: false, composeFiles: [] })
    })

    it('rejects an unknown flag, a missing value, and a bad agent', () => {
      expect(parseAttachArgs(['--nope'])).toEqual({ kind: 'error', message: 'Unknown option "--nope".' })
      expect(parseAttachArgs(['--coordinator'])).toEqual({ kind: 'error', message: '--coordinator needs a value.' })
      expect(parseAttachArgs(['--agent', 'both-of-them'])).toEqual({ kind: 'error', message: '--agent must be one of: coder, spec, both.' })
    })

    it('treats -h/--help as help', () => {
      expect(parseAttachArgs(['--help'])).toEqual({ kind: 'help' })
      expect(parseAttachArgs(['-h'])).toEqual({ kind: 'help' })
    })
  })

  describe('deriveServerUrl', () => {
    it('maps wss->https and ws->http, keeping just the origin', () => {
      expect(deriveServerUrl('wss://dev.example.com/api/relay/runtime')).toBe('https://dev.example.com')
      expect(deriveServerUrl('ws://localhost:8787/api/relay/runtime')).toBe('http://localhost:8787')
    })
  })

  describe('resolveAttach', () => {
    const cwd = '/here'
    it('fills defaults: server from coordinator, org=local, dir=cwd', () => {
      const r = resolveAttach(attach({ coordinator: 'wss://h/api/relay/runtime', project: 'p', token: 't' }), {}, cwd)
      expect(r).toEqual({
        kind: 'ok',
        options: { coordinator: 'wss://h/api/relay/runtime', server: 'https://h', token: 't', org: 'local', project: 'p', dir: '/here', agent: 'both', build: false, ref: undefined },
      })
    })

    it('reads coordinator, project, token, org from the environment when flags are absent', () => {
      const env = { COORDINATOR_URL: 'wss://h/r', PROJECT_ID: 'penv', DEVICE_TOKEN: 'tenv', ORG: 'acme' }
      const r = resolveAttach(attach({}), env, cwd)
      expect(r).toMatchObject({ kind: 'ok', options: { project: 'penv', token: 'tenv', org: 'acme' } })
    })

    it('a flag wins over the environment', () => {
      const r = resolveAttach(attach({ project: 'flag' }), { PROJECT_ID: 'env', COORDINATOR_URL: 'wss://h/r', DEVICE_TOKEN: 't' }, cwd)
      expect(r).toMatchObject({ kind: 'ok', options: { project: 'flag' } })
    })

    it('resolves --dir to an absolute path against cwd (so "." is where you ran spectra, not the compose dir)', () => {
      const base = { coordinator: 'wss://h/r', project: 'p', token: 't' }
      const dirOf = (flags: Record<string, string>): string => {
        const r = resolveAttach(attach({ ...base, ...flags }), {}, cwd)
        if (r.kind !== 'ok') throw new Error('expected ok')
        return r.options.dir
      }
      expect(dirOf({ dir: '.' })).toBe('/here')
      expect(dirOf({ dir: './sub' })).toBe('/here/sub')
      expect(dirOf({ dir: 'sub' })).toBe('/here/sub')
      expect(dirOf({ dir: '../elsewhere' })).toBe('/elsewhere')
      expect(dirOf({ dir: '/abs/path' })).toBe('/abs/path') // an absolute --dir is left as-is
    })

    it('errors on a missing coordinator, project, or token, or unparseable coordinator', () => {
      expect(resolveAttach(attach({ project: 'p', token: 't' }), {}, cwd)).toMatchObject({ kind: 'error' })
      expect(resolveAttach(attach({ coordinator: 'wss://h/r', token: 't' }), {}, cwd)).toMatchObject({ kind: 'error' })
      expect(resolveAttach(attach({ coordinator: 'wss://h/r', project: 'p' }), {}, cwd)).toMatchObject({ kind: 'error' })
      expect(resolveAttach(attach({ coordinator: 'not a url', project: 'p', token: 't' }), {}, cwd)).toMatchObject({ kind: 'error' })
    })

    it('accepts an https:// (or bare) coordinator and derives the relay URL + server origin', () => {
      expect(resolveAttach(attach({ coordinator: 'https://h', project: 'p', token: 't' }), {}, cwd)).toMatchObject({
        kind: 'ok',
        options: { coordinator: 'wss://h/api/relay/runtime', server: 'https://h' },
      })
    })
  })

  describe('orgForProject', () => {
    const projects = [
      { org: 'acme', id: 'acme-9f2', name: 'Acme' },
      { org: 'globex', id: 'gbx-1', name: 'Globex' },
    ]
    it('returns the org of the matching project', () => {
      expect(orgForProject(projects, 'acme-9f2')).toBe('acme')
      expect(orgForProject(projects, 'gbx-1')).toBe('globex')
    })
    it('returns undefined when the id is not listed (caller falls back to local)', () => {
      expect(orgForProject(projects, 'nope')).toBeUndefined()
      expect(orgForProject([], 'acme-9f2')).toBeUndefined()
    })
  })

  describe('attachEnv + attachComposeArgv', () => {
    it('maps resolved options to the env attach.yaml interpolates (no model credential)', () => {
      const { options } = resolveAttach(attach({ coordinator: 'wss://h/api/relay/runtime', project: 'p', token: 't', org: 'acme', dir: '/w' }), {}, '/here') as { options: import('./commands.js').AttachOptions }
      expect(attachEnv(options)).toEqual({
        COORDINATOR_URL: 'wss://h/api/relay/runtime',
        SERVER_URL: 'https://h',
        DEVICE_TOKEN: 't',
        ORG: 'acme',
        PROJECT_ID: 'p',
        ATTACH_PROJECT_DIR: '/w',
      })
    })

    it('runs a foreground up of both services, or one named agent', () => {
      expect(attachComposeArgv('both', [ATTACH])).toEqual(['-f', ATTACH, 'up'])
      expect(attachComposeArgv('coder', [ATTACH])).toEqual(['-f', ATTACH, 'up', 'coder'])
      expect(attachComposeArgv('spec', [ATTACH], '/cfg/spectra.env')).toEqual(['--env-file', '/cfg/spectra.env', '-f', ATTACH, 'up', 'spec'])
      expect(attachComposeArgv('coder', [ATTACH], undefined, true)).toEqual(['-f', ATTACH, 'up', '--build', 'coder'])
    })
  })
})

describe('spectra login / logout parsing', () => {
  it('parses login flags', () => {
    expect(parseLoginArgs(['--coordinator', 'wss://h/r', '--label', 'work laptop'])).toEqual({
      kind: 'login',
      coordinator: 'wss://h/r',
      label: 'work laptop',
    })
    expect(parseLoginArgs([])).toEqual({ kind: 'login', coordinator: undefined, label: undefined })
  })

  it('parses logout, and rejects junk', () => {
    expect(parseLogoutArgs(['--coordinator', 'wss://h/r'])).toEqual({ kind: 'logout', coordinator: 'wss://h/r' })
    expect(parseLoginArgs(['--nope'])).toMatchObject({ kind: 'error' })
    expect(parseLoginArgs(['--coordinator'])).toMatchObject({ kind: 'error' })
    expect(parseLogoutArgs(['--label', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseLoginArgs(['-h'])).toEqual({ kind: 'help' })
  })
})

describe('spectra projects parsing', () => {
  it('parses an optional --coordinator', () => {
    expect(parseProjectsArgs([])).toEqual({ kind: 'projects', coordinator: undefined })
    expect(parseProjectsArgs(['--coordinator', 'wss://h/r'])).toEqual({ kind: 'projects', coordinator: 'wss://h/r' })
  })
  it('help and errors', () => {
    expect(parseProjectsArgs(['-h'])).toEqual({ kind: 'help' })
    expect(parseProjectsArgs(['--nope'])).toMatchObject({ kind: 'error' })
    expect(parseProjectsArgs(['--coordinator'])).toMatchObject({ kind: 'error' })
  })
})
