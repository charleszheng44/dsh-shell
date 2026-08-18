#!/usr/bin/env node

/**
 * Argument parsing and idempotent process/terminal cleanup.
 *
 * One lifecycle owner holds the root AbortController, the signal disposers,
 * and an idempotent shutdown: every exit path (Ctrl+C, SIGINT, SIGTERM, boot
 * failure, uncaught render error) aborts networking, restores the alternate
 * screen, removes signal handlers, and sets the exit status exactly once.
 */

import { parseArgs } from 'node:util'

import { App } from './app.js'
import { NodeApiClient, createDshPort } from './dsh.js'
import { TerminalView } from './ui.js'

/** Default loopback host, per the design doc. */
export const DEFAULT_HOST = 'http://127.0.0.1:3080'

export type HostParseResult =
  | { ok: true; origin: URL }
  | { ok: false; error: string }

/**
 * Parse and validate --host: only http: origins whose hostname is exactly
 * 127.0.0.1 or localhost, no credentials, root path only, no query or
 * fragment. The accepted value is normalized to an origin.
 */
export function parseHostArg(args: readonly string[]): HostParseResult {
  let host: string | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { host: { type: 'string', default: DEFAULT_HOST } },
      strict: true,
      allowPositionals: false,
    })
    host = parsed.values.host
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const raw = host ?? DEFAULT_HOST
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: `invalid --host URL: ${raw}` }
  }
  if (url.protocol !== 'http:') {
    return { ok: false, error: `only http:// origins are accepted, got ${url.protocol}//` }
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return { ok: false, error: `only loopback hostnames are accepted, got ${url.hostname}` }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'credentials are not accepted in --host' }
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, error: `only the origin root path is accepted, got ${url.pathname}` }
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'query strings and fragments are not accepted in --host' }
  }
  return { ok: true, origin: new URL(url.origin) }
}

export interface LifecycleDeps {
  abort: () => void
  stop: () => void
  exit: (code: number) => void
  disposeSignals: () => void
}

/**
 * Idempotent shutdown gate: the first call wins and runs every step exactly
 * once; later calls are no-ops.
 */
export function createLifecycle(deps: LifecycleDeps): (code: number) => void {
  let done = false
  return (code) => {
    if (done) return
    done = true
    deps.disposeSignals()
    deps.abort()
    deps.stop()
    deps.exit(code)
  }
}

/** Program entry: parse, boot, and run until shutdown; resolves the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseHostArg(argv)
  if (!parsed.ok) {
    console.error(`dsh-tui: ${parsed.error}`)
    return 2
  }
  const { origin } = parsed

  const controller = new AbortController()
  let resolveExit: (code: number) => void = () => undefined
  const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve })

  // Signals must reach the same idempotent gate as Ctrl+C and boot failure.
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = []
  const disposeSignals = (): void => {
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler)
    }
  }

  const view = new TerminalView(
    () => { void app.openProjectPicker() },
    () => { void app.openSessionPicker() },
    () => { shutdown(0) },
  )
  const app = new App(createDshPort(new NodeApiClient(origin)), view, controller.signal)

  const shutdown = createLifecycle({
    abort: () => controller.abort(),
    stop: () => view.stop(),
    exit: (code) => { resolveExit(code) },
    disposeSignals,
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => { shutdown(0) }
    process.once(signal, handler)
    signalHandlers.push({ signal, handler })
  }

  // Render failures must not leave the terminal dirty: route them through the
  // one shutdown path with a nonzero exit.
  const onUncaught = (error: Error): void => {
    console.error(`dsh-tui: ${error.message ?? String(error)}`)
    shutdown(1)
  }
  process.on('uncaughtException', onUncaught)

  try {
    view.start()
    const boot = await app.boot()
    if (!boot.ok) {
      console.error(`dsh-tui: ${origin}: ${boot.error.message}`)
      shutdown(1)
    }
  } catch (error) {
    console.error(`dsh-tui: ${origin}: ${error instanceof Error ? error.message : String(error)}`)
    shutdown(1)
  }
  const code = await exitPromise
  process.removeListener('uncaughtException', onUncaught)
  return code}

// Direct execution: run the real entry.
const isMain = process.argv[1] !== undefined
  && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'))
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code)
  })
}
