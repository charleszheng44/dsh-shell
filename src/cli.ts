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
import { TerminalView, terminalSafeText } from './ui.js'

/** Default loopback host, per the design doc. */
export const DEFAULT_HOST = 'http://127.0.0.1:3080'

/** Upper bound on waiting for the stream pump to settle after abort. */
export const PUMP_SETTLE_TIMEOUT_MS = 2_000

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
  // parseArgs silently accepts repeated options with last-wins semantics;
  // a single-option CLI should reject them so a typo cannot go unnoticed.
  const count = args.filter((arg) => arg === '--host' || arg.startsWith('--host=')).length
  if (count > 1) {
    return { ok: false, error: '--host may be given at most once' }
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
    try {
      deps.disposeSignals()
      deps.abort()
    } catch {
      // Teardown failures must not prevent exit delivery.
    }
    try {
      deps.stop()
    } catch {
      // A throwing stop (e.g. write to a closed terminal fd) must not hang
      // the process or crash after the gate: the exit code is always
      // delivered exactly once.
    } finally {
      deps.exit(code)
    }
  }
}

/** Program entry: parse, boot, and run until shutdown; resolves the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseHostArg(argv)
  if (!parsed.ok) {
    console.error(terminalSafeText(`dsh-tui: ${parsed.error}`))
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
    stop: () => app.shutdown(),
    // The published client's abort closes the WebSocket, so the pump settles
    // without any timeout or forced exit; resolve only once it has.
    exit: (code) => {
      // The published client's abort closes the WebSocket, so the pump
      // normally settles immediately; a host that ignores the closing
      // handshake must not hang the exit, so bound the wait.
      const deadline = AbortSignal.timeout(PUMP_SETTLE_TIMEOUT_MS)
      void Promise.race([app.waitForPump(), new Promise((resolve) => {
        deadline.addEventListener('abort', resolve, { once: true })
      })]).finally(() => { resolveExit(code) })
    },
    disposeSignals,
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // 128+N mirrors shell convention so a killed run is distinguishable from
    // a clean Ctrl+C quit by supervisors.
    const handler = (): void => { shutdown(signal === 'SIGINT' ? 130 : 143) }
    process.once(signal, handler)
    signalHandlers.push({ signal, handler })
  }

  // Render failures must not leave the terminal dirty: route them through the
  // one shutdown path with a nonzero exit.
  const disposeFailures = installFailureHandlers(shutdown)

  try {
    view.start()
    const boot = await app.boot()
    if (!boot.ok && !controller.signal.aborted) {
      shutdown(1)
      console.error(terminalSafeText(`dsh-tui: ${origin}: ${boot.error.message}`))
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      shutdown(1)
      console.error(terminalSafeText(`dsh-tui: ${origin}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  const code = await exitPromise
  disposeFailures()
  return code}

/** Route uncaughtException/unhandledRejection through the one shutdown gate
 *  with a nonzero exit and a terminal-safe stderr line. Returns a disposer. */
export function installFailureHandlers(shutdown: (code: number) => void): () => void {
  const onUncaught = (error: Error): void => {
    shutdown(1)
    console.error(terminalSafeText(`dsh-tui: ${error.message ?? String(error)}`))
  }
  process.on('uncaughtException', onUncaught)
  const onUnhandledRejection = (reason: unknown): void => {
    shutdown(1)
    console.error(terminalSafeText(`dsh-tui: ${reason instanceof Error ? reason.message : String(reason)}`))
  }
  process.on('unhandledRejection', onUnhandledRejection)
  return () => {
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onUnhandledRejection)
  }
}

// Direct execution: run the real entry. A rejection from main (only possible
// before the gate exists, since every later path resolves through it) exits
// with a nonzero code and no terminal was started yet, so nothing to restore.
const isMain = process.argv[1] !== undefined
  && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'))
if (isMain) {
  void main(process.argv.slice(2)).then(
    (code) => { process.exit(code) },
    (error: unknown) => {
      console.error(terminalSafeText(`dsh-tui: ${error instanceof Error ? error.message : String(error)}`))
      process.exit(1)
    },
  )
}
