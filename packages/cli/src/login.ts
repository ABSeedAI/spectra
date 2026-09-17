/**
 * `spectra login` / `spectra logout` — the impure half of the browser (loopback) device-token flow.
 *
 * login opens the browser to `<coordinator-origin>/api/auth/cli/start`, where the signed-in user
 * approves this machine; the coordinator redirects a one-time code to a localhost server this process
 * spins up; we exchange that code for a device token and save it under the config home, keyed by
 * coordinator origin. `spectra attach` then reads it, so no `--token` is needed.
 *
 * The parsing and the origin-derivation are pure (commands.ts); everything here needs a real machine —
 * an HTTP server, a browser, a network round-trip — and is deliberately kept out of that pure surface.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { coordinatorOrigin, LOGIN_USAGE, parseLoginArgs, parseLogoutArgs } from './commands.js'
import { readCredentials, removeCredential, storeCredential } from './credentials.js'

/** Resolve + validate a coordinator into its origin, or return an error message. */
function resolveLoginOrigin(coordinator: string | undefined): { origin: string } | { error: string } {
  if (!coordinator) return { error: 'login needs --coordinator (e.g. https://your-coordinator or wss://…), or set COORDINATOR_URL.' }
  const origin = coordinatorOrigin(coordinator)
  if (!origin) return { error: `Not a valid coordinator URL or host: "${coordinator}".` }
  return { origin }
}

/**
 * Open the OS browser at `url`, best-effort — the printed URL is the fallback. `spawn` reports a
 * missing opener via an async `'error'` event (not a throw), so each attempt carries an error handler
 * that moves on to the next candidate; when none exist (a bare WSL/container), it gives up silently.
 */
function openBrowser(url: string): void {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [url]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '', url]]]
        : [
            ['xdg-open', [url]], // most Linux desktops
            ['wslview', [url]], // WSL → the Windows default browser
            ['gio', ['open', url]], // GNOME fallback
          ]

  const attempt = (i: number): void => {
    if (i >= candidates.length) return // no opener available; the printed URL is the fallback
    const [cmd, args] = candidates[i]!
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => attempt(i + 1))
    child.unref()
  }
  attempt(0)
}

const DONE_PAGE =
  '<!doctype html><meta charset=utf-8><title>Spectra</title>' +
  '<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e7e9ee">' +
  '<div>✓ Authorized. You can close this tab and return to your terminal.</div>'

/**
 * Serve a one-shot localhost endpoint and resolve with the `code` the coordinator redirects to it.
 * Times out so a login the user abandons does not hang forever.
 */
export function awaitCode(timeoutMs = 180_000): Promise<{ port: number; code: Promise<string> }> {
  return new Promise((resolveServer, rejectServer) => {
    let settle: (code: string) => void
    let fail: (err: Error) => void
    const code = new Promise<string>((res, rej) => {
      settle = res
      fail = rej
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/cb') {
        res.writeHead(404).end()
        return
      }
      const value = url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html' }).end(DONE_PAGE)
      server.close()
      clearTimeout(timer)
      if (value) settle(value)
      else fail(new Error('The coordinator did not return a code.'))
    })

    const timer = setTimeout(() => {
      server.close()
      fail(new Error('Timed out waiting for browser approval.'))
    }, timeoutMs)

    server.on('error', (err) => rejectServer(err))
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ port: (server.address() as AddressInfo).port, code })
    })
  })
}

export async function runLogin(argv: string[], configHome: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseLoginArgs(argv)
  if (parsed.kind === 'help') return void console.log(LOGIN_USAGE), 0
  if (parsed.kind === 'error') return void console.error(parsed.message), void console.error('\nRun `spectra login --help` for usage.'), 2

  const resolved = resolveLoginOrigin(parsed.coordinator ?? env.COORDINATOR_URL)
  if ('error' in resolved) return void console.error(resolved.error), 2
  const { origin } = resolved
  const label = parsed.label?.trim() || os.hostname()

  const { port, code } = await awaitCode()
  const start = `${origin}/api/auth/cli/start?redirect=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}&label=${encodeURIComponent(label)}`
  console.log(`Opening ${origin} to authorize this machine…`)
  console.log(`If your browser did not open, visit:\n  ${start}\n`)
  openBrowser(start)

  let oneTimeCode: string
  try {
    oneTimeCode = await code
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }

  const res = await fetch(`${origin}/api/auth/cli/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: oneTimeCode }),
  })
  const body = (await res.json().catch(() => ({}))) as { token?: string; label?: string; error?: string }
  if (!res.ok || !body.token) {
    console.error(body.error ?? `Could not exchange the code (${res.status}).`)
    return 1
  }

  // Store the canonical origin as the coordinator too, so `attach` derives the relay URL from it (and
  // never depends on whatever scheme/path was typed at login).
  storeCredential(configHome, origin, { token: body.token, label: body.label ?? label, coordinator: origin, createdAt: new Date().toISOString() })
  console.log(`✓ Logged in to ${origin} as "${body.label ?? label}". \`spectra attach\` will use this token.`)
  return 0
}

export function runLogout(argv: string[], configHome: string, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseLogoutArgs(argv)
  if (parsed.kind === 'help') return void console.log(LOGIN_USAGE), 0
  if (parsed.kind === 'error') return void console.error(parsed.message), 2

  // Fall back to the sole stored coordinator when there is exactly one and none was named.
  let coordinator = parsed.coordinator ?? env.COORDINATOR_URL
  if (!coordinator) {
    const stored = Object.values(readCredentials(configHome))
    if (stored.length === 1) coordinator = stored[0]!.coordinator
  }
  const resolved = resolveLoginOrigin(coordinator)
  if ('error' in resolved) return void console.error(resolved.error), 2

  const removed = removeCredential(configHome, resolved.origin)
  if (!removed) {
    console.log(`No stored token for ${resolved.origin}.`)
    return 0
  }
  console.log(`✓ Removed the local token for ${resolved.origin}. To revoke it on the server, use "Connect a runtime" in the app.`)
  return 0
}
