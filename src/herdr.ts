/**
 * Herdr pane-state reporting.
 *
 * Herdr is a terminal workspace manager for coding agents: it shows each
 * pane's agent state (idle / working / blocked) in a sidebar. It cannot
 * detect dsh-shell on its own — "adding a completely new agent still requires
 * a Herdr binary update" — but it publishes a supported path for agents that
 * report themselves, which is what this module uses.
 *
 * Reporting is self-driving from state dsh-shell already keeps, so `blocked`
 * is exact: Herdr's screen-manifest agents can only infer it from visible
 * approval UI, while dsh-shell knows from the host's own event stream.
 *
 * Everything here is a no-op outside Herdr, and no caller depends on the
 * outcome, so a missing or failing `herdr` binary cannot affect the shell.
 */

import { spawn } from 'node:child_process'

/** States a custom integration may report. Herdr derives `done` itself, so it
 *  is deliberately not reportable. */
export type HerdrState = 'idle' | 'working' | 'blocked'

/**
 * The subset of `AppState` that decides the reported state. Declared
 * structurally so this module never imports `app.ts`, which imports it.
 */
export interface HerdrStateView {
  readonly attachment: {
    readonly phase: string
    readonly turnActive?: number | undefined
    readonly pendingQuestions?: readonly unknown[] | undefined
    readonly pendingApprovals?: readonly unknown[] | undefined
  }
}

export interface HerdrReporter {
  /** Report the state `state` implies, if it changed since the last report. */
  sync(state: HerdrStateView): void
  /** Hand lifecycle authority back to Herdr. Safe to call when never reported. */
  release(): void
}

export interface HerdrReporterDeps {
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Sink for one `herdr` invocation; defaults to a detached spawn. */
  spawn?: (bin: string, args: readonly string[]) => void
}

/**
 * Stable, integration-unique source id. Herdr discards stale `--seq` values
 * per source, so this must never be shared with another reporter. It stays
 * `dsh-shell` even though the sidebar label is `deepseek`: the source keys the
 * reporter, and two clients that both speak for DeepSeek Harness must not
 * collide on it.
 */
const SOURCE = 'custom:dsh-shell'

/**
 * The label Herdr shows for this agent in its sidebar. Herdr has no built-in
 * `deepseek` kind (`herdr agent` lists pi, claude, codex, … but not deepseek),
 * which is exactly why the agent reports itself over the supported
 * `pane report-agent` path instead of being screen-detected.
 */
const AGENT = 'deepseek'

/**
 * An open approval or question is `blocked` (Herdr's "needs a user decision");
 * a running turn is `working`; otherwise the prompt is ready for input.
 * A block outranks a running turn, because the turn is what is waiting.
 */
export function herdrStateFor(state: HerdrStateView): HerdrState {
  const { attachment } = state
  if (attachment.phase !== 'attached') return 'idle'
  const pending = (attachment.pendingQuestions?.length ?? 0) + (attachment.pendingApprovals?.length ?? 0)
  if (pending > 0) return 'blocked'
  return attachment.turnActive === undefined ? 'idle' : 'working'
}

/** Short sidebar reason for a block, e.g. "2 approvals, 1 question". */
function blockedMessage(state: HerdrStateView): string {
  const approvals = state.attachment.pendingApprovals?.length ?? 0
  const questions = state.attachment.pendingQuestions?.length ?? 0
  const parts: string[] = []
  if (approvals > 0) parts.push(approvals === 1 ? '1 approval' : `${approvals} approvals`)
  if (questions > 0) parts.push(questions === 1 ? '1 question' : `${questions} questions`)
  return parts.join(', ')
}

/** Fire-and-forget: reporting must never block, throw into, or outlive the shell. */
function spawnDetached(bin: string, args: readonly string[]): void {
  try {
    const child = spawn(bin, [...args], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // A broken herdr install is not dsh-shell's problem.
  }
}

export function createHerdrReporter(deps: HerdrReporterDeps = {}): HerdrReporter {
  const env = deps.env ?? process.env
  const spawnFn = deps.spawn ?? spawnDetached
  const pane = env.HERDR_PANE_ID ?? ''
  const bin = env.HERDR_BIN_PATH ?? ''
  // Reporting is meaningless without a pane to report against, and Herdr only
  // sets these inside its own panes — so this is the outside-Herdr no-op.
  const active = env.HERDR_ENV === '1' && pane !== '' && bin !== ''

  let last: HerdrState | undefined
  let seq = 0

  return {
    sync(state) {
      if (!active) return
      const next = herdrStateFor(state)
      // Transitions only: setState runs per streamed frame, and a spawn per
      // frame would be absurd. `--seq` orders whatever remains.
      if (next === last) return
      last = next
      seq += 1
      const args = [
        'pane', 'report-agent', pane,
        '--source', SOURCE,
        '--agent', AGENT,
        '--state', next,
        '--seq', String(seq),
      ]
      if (next === 'blocked') args.push('--message', blockedMessage(state))
      spawnFn(bin, args)
    },
    release() {
      // Never reported, so there is no authority to hand back.
      if (!active || last === undefined) return
      last = undefined
      spawnFn(bin, ['pane', 'release-agent', pane, '--source', SOURCE, '--agent', AGENT])
    },
  }
}
