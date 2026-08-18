/**
 * Selection, attachment, and transcript orchestration.
 *
 * App holds the whole UI state machine (connection, project/session rows,
 * attachment lifecycle, notices) and drives a narrow view seam so the same
 * orchestration runs headless in tests. The design doc's AttachmentState
 * discriminated union keeps attachment lifecycle in one place; the generation
 * counter makes late history results from an older attachment invisible.
 */

import { basename } from 'node:path'

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api'
// Activates the title projection-key augmentation so
// SessionSummary.projections.values.title is typed; type-only, no runtime cost.
import type {} from '@deepseek-ai/dsh-session-title/types'

import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'

import type { DshPort, HostDescription } from './dsh.js'
import { applyEvent, projectEvents, type PartialAssistant, type TranscriptRow } from './transcript.js'

/** A pickable project row: the special "All sessions" bucket or one Workspace. */
export type ProjectRow = {
  key: WorkspaceId | 'all'
  title: string
}

/** A pickable session row for the current project filter. */
export interface SessionRow {
  sessionId: SessionId
  title: string
}

/**
 * Attachment lifecycle. `buffered` collects stream frames while history is
 * loading (PR 3); PR 2 fills it with nothing and attaches from history alone.
 */
export type AttachmentState =
  | { phase: 'none' }
  | {
      phase: 'loading'
      sessionId: SessionId
      generation: number
      buffered: SessionEvent[]
    }
  | {
      phase: 'attached'
      sessionId: SessionId
      generation: number
      lastSeq: number
      transcript: readonly TranscriptRow[]
      partial: PartialAssistant | undefined
      sending: boolean
    }

/** Complete UI state, rendered by the view on every change. */
export interface AppState {
  connection: 'connecting' | 'connected' | 'disconnected'
  projects: readonly ProjectRow[]
  sessions: readonly SessionRow[]
  selectedProject: WorkspaceId | 'all' | undefined
  attachment: AttachmentState
  notice: string | undefined
}

/** The view seam: explicit render requests and picker overlays. */
export interface AppView {
  render(state: AppState): void
  openProjectPicker(rows: readonly ProjectRow[], onSelect: (row: ProjectRow) => void, onCancel: () => void): void
  openSessionPicker(rows: readonly SessionRow[], onSelect: (row: SessionRow) => void, onCancel: () => void): void
  closePicker(): void
  stop(): void
}

/** Project picker rows: "All sessions" first, then Workspaces in list order. */
export function projectRows(workspaces: readonly WorkspaceView[]): readonly ProjectRow[] {
  return [
    { key: 'all', title: 'All sessions' },
    ...workspaces.map((workspace) => ({ key: workspace.workspaceId, title: workspace.title })),
  ]
}

/** Session picker rows for one project, filtered and ordered per the design doc. */
export function sessionRows(
  workspaces: readonly WorkspaceView[],
  sessions: readonly SessionSummary[],
  archivedSessionIds: readonly SessionId[],
  project: WorkspaceId | 'all',
): readonly SessionRow[] {
  const archived = new Set(archivedSessionIds)
  const attachable = sessions.filter((session) =>
    !archived.has(session.sessionId)
    && session.origin !== 'subagent'
    && !session.blank)
  const ordered = project === 'all'
    ? attachable
    : orderByWorkspace(attachable, workspaces, project)
  return ordered.map((session) => ({ sessionId: session.sessionId, title: sessionTitle(session) }))
}

function orderByWorkspace(
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceView[],
  project: WorkspaceId,
): readonly SessionSummary[] {
  const workspace = workspaces.find((candidate) => candidate.workspaceId === project)
  if (workspace === undefined) return []
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const ordered: SessionSummary[] = []
  for (const sessionId of workspace.sessionIds) {
    const session = byId.get(sessionId)
    if (session !== undefined) ordered.push(session)
  }
  return ordered
}

/** Row label: the title projection when a string, else cwd basename, else the id. */
export function sessionTitle(session: SessionSummary): string {
  const title = session.projections?.values.title
  if (typeof title === 'string' && title !== '') return title
  const cwd = session.cwd
  if (cwd !== undefined && cwd !== '') {
    const name = basename(cwd)
    if (name !== '' && name !== '/') return name
  }
  return session.sessionId
}

const emptyAttachment: AttachmentState = { phase: 'none' }

export function initialState(): AppState {
  return {
    connection: 'connecting',
    // The All sessions bucket is always present, even when the first list
    // refresh fails and no workspaces are known yet.
    projects: projectRows([]),
    sessions: [],
    selectedProject: undefined,
    attachment: emptyAttachment,
    notice: undefined,
  }
}

/**
 * App orchestration. One instance owns the state; every mutation renders
 * through the view. Stale attachment work is suppressed by generation.
 */
export class App {
  private state: AppState = initialState()
  private generation = 0
  private closed = false
  private pickerRequest = 0

  constructor(
    private readonly port: DshPort,
    private readonly view: AppView,
    private readonly signal: AbortSignal,
  ) {}

  getState(): AppState {
    return this.state
  }

  /** Startup: describe, start the mux stream, await its physical readiness,
   *  then mark connected and open the project picker. */
  async boot(): Promise<RpcBootResult> {
    this.setState({ connection: 'connecting' })
    const describe = await this.port.describe(this.signal)
    if (!describe.ok) {
      return { ok: false, error: describe.error }
    }
    const ready = await this.startStream()
    if (!ready) {
      return { ok: false, error: { code: 'internal', message: 'event stream failed to open' } }
    }
    this.setState({ connection: 'connected' })
    await this.openProjectPicker()
    return { ok: true, host: describe.value }
  }

  /**
   * Start the mux pump and wait for its physical onOpen. The iterable is
   * lazy, so this returns only once the socket is actually readable; frames
   * keep draining while the caller proceeds.
   */
  private startStream(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      const settle = (opened: boolean): void => {
        if (settled) return
        settled = true
        if (readyTimer !== undefined) clearTimeout(readyTimer)
        resolve(opened)
      }
      this.streamPump = this.pumpStream(() => settle(true), () => settle(false))
      // A host that accepts the TCP/WS upgrade then stalls must not hang
      // boot; treat the deadline as a failed open.
      readyTimer = setTimeout(() => settle(false), STREAM_READY_TIMEOUT_MS)
    })
  }

  /** The active stream pump, awaited at shutdown so no socket is left live. */
  private streamPump: Promise<void> | undefined
  /** Set on stream/error so the pump stops consuming like a stream end. */
  private streamAborted = false
  /** Attachment generation awaiting its prompt's user/message echo. */
  private pendingAccepted: number | undefined

  /** Drain mux frames until the stream ends, throws, or emits stream/error. */
  private async pumpStream(onOpen: () => void, onEnded: () => void): Promise<void> {
    // Distinguish the stream's own throw (design: mark disconnected) from a
    // throw inside onFrame's render path (design: run the shutdown path).
    let renderError: unknown
    try {
      for await (const frame of this.port.stream(this.signal, onOpen)) {
        if (this.closed) break
        try {
          this.onFrame(frame)
        } catch (error) {
          renderError = error
          throw error
        }
        if (this.streamAborted) break
      }
    } catch (error) {
      if (!this.signal.aborted && renderError === undefined) {
        // The stream itself failed: disconnected, per the failure table.
        onEnded()
        // A stream failure is a disconnect regardless of the prior state
        // (boot included); keep a stream/error-specific notice if present.
        this.setState({
          connection: 'disconnected',
          notice: this.streamAborted
            ? this.state.notice ?? 'Disconnected: restart dsh-tui to reconnect'
            : 'Disconnected: restart dsh-tui to reconnect',
        })
        return
      }
      throw error
    }
    onEnded()
    if (!this.closed) {
      // stream/error already set its specific notice; keep it.
      this.setState({
        connection: 'disconnected',
        notice: this.streamAborted
          ? this.state.notice ?? 'Disconnected: restart dsh-tui to reconnect'
          : 'Disconnected: restart dsh-tui to reconnect',
      })
    }
  }

  /** Route one mux frame: buffer or apply selected-session events, ignore the rest. */
  private onFrame(frame: MuxFrame): void {
    // Once closed or disconnected, no further frame may mutate the view.
    if (this.closed || this.state.connection !== 'connected') return
    if (frame.type === 'stream/error') {
      this.setState({ connection: 'disconnected', notice: 'Disconnected: stream error' })
      this.streamAborted = true
      return
    }
    if (frame.type !== 'session/event') return
    const attachment = this.state.attachment
    if (attachment.phase === 'none' || attachment.sessionId !== frame.sessionId) return
    if (attachment.phase === 'loading') {
      // Buffer only what a history round-trip needs; a flooding host past the
      // cap is treated as a stream failure rather than unbounded growth.
      if (attachment.buffered.length >= MAX_BUFFERED_EVENTS) {
        this.setState({ connection: 'disconnected', notice: 'Disconnected: event flood' })
        this.streamAborted = true
        return
      }
      this.setState({ attachment: { ...attachment, buffered: [...attachment.buffered, frame.event] } })
      return
    }
    // attached: apply live events under the overlap and continuity rules.
    // The accepted notice is transient: the prompt's own append-origin
    // user/message echo (rendered below) supersedes it.
    if (this.pendingAccepted === attachment.generation
      && frame.event.type === 'user/message'
      && frame.event.surfaceOp === 'append'
      && frame.event.data.source.kind === 'user'
      && frame.event.seq > attachment.lastSeq) {
      this.pendingAccepted = undefined
      this.setState({ notice: undefined })
    }
    if (frame.event.seq <= attachment.lastSeq) return
    if (frame.event.seq !== attachment.lastSeq + 1) {
      this.setState({ connection: 'disconnected', notice: 'Disconnected: sequence gap' })
      this.streamAborted = true
      return
    }
    const next = applyEvent(
      { rows: attachment.transcript, partial: attachment.partial, lastSeq: attachment.lastSeq },
      frame.event,
    )
    this.setState({
      attachment: {
        ...attachment,
        lastSeq: next.lastSeq,
        transcript: next.rows,
        partial: next.partial,
      },
    })
  }

  /**
   * Re-fetch both lists; a failure keeps the current rows and surfaces a
   * notice. Writes state only when this refresh belongs to the newest picker
   * request, so a superseded refresh can never clobber newer rows or notices.
   */
  async refreshLists(): Promise<void> {
    if (this.closed) return
    const request = this.pickerRequest
    const [workspaces, sessions] = await Promise.all([
      this.port.listWorkspaces(this.signal),
      this.port.listSessions(this.signal),
    ])
    if (this.closed || request !== this.pickerRequest) return
    if (!workspaces.ok) {
      this.setState({ notice: workspaces.error.message })
      return
    }
    if (!sessions.ok) {
      this.setState({ notice: sessions.error.message })
      return
    }
    const project = this.state.selectedProject
    const rows = project === undefined
      ? []
      : sessionRows(workspaces.value.items, sessions.value.items, workspaces.value.archivedSessionIds, project)
    this.setState({
      projects: projectRows(workspaces.value.items),
      sessions: rows,
      // Only a connected refresh may clear a disconnect instruction.
      notice: this.state.connection === 'connected' ? undefined : this.state.notice,
    })
    this.rowsCache = {
      workspaces: workspaces.value.items,
      sessions: sessions.value.items,
      archived: workspaces.value.archivedSessionIds,
    }
  }

  private rowsCache: {
    workspaces: readonly WorkspaceView[]
    sessions: readonly SessionSummary[]
    archived: readonly SessionId[]
  } = { workspaces: [], sessions: [], archived: [] }

  /** Ctrl+P: open the project picker (refreshes both lists first). */
  async openProjectPicker(): Promise<void> {
    const request = ++this.pickerRequest
    await this.refreshLists()
    if (this.closed || request !== this.pickerRequest) return
    const rows = this.state.projects
    this.view.openProjectPicker(rows, (row) => { void this.selectProject(row) }, () => this.view.closePicker())
  }

  /** Ctrl+S (or after a project pick): open the session picker for the current project. */
  async openSessionPicker(): Promise<void> {
    const request = ++this.pickerRequest
    await this.refreshLists()
    if (this.closed || request !== this.pickerRequest) return
    const project = this.state.selectedProject
    if (project === undefined) {
      this.view.openProjectPicker(this.state.projects, (row) => { void this.selectProject(row) }, () => this.view.closePicker())
      return
    }
    const rows = sessionRows(
      this.rowsCache.workspaces,
      this.rowsCache.sessions,
      this.rowsCache.archived,
      project,
    )
    this.view.openSessionPicker(rows, (row) => { void this.attach(row.sessionId) }, () => this.view.closePicker())
  }

  /** Remember the chosen project and immediately open its session picker. */
  async selectProject(row: ProjectRow): Promise<void> {
    if (this.closed) return
    this.view.closePicker()
    this.setState({ selectedProject: row.key })
    await this.openSessionPicker()
  }

  /** Attach to a session: load one tail history page and project it. */
  async attach(sessionId: SessionId): Promise<void> {
    if (this.closed) return
    if (this.state.connection !== 'connected') {
      // A dead stream cannot attach; keep the picker open and explain.
      this.setState({ notice: 'Disconnected: restart dsh-tui to reconnect' })
      return
    }
    this.view.closePicker()
    const generation = ++this.generation
    this.pendingAccepted = undefined
    this.setState({
      attachment: { phase: 'loading', sessionId, generation, buffered: [] },
    })
    const history = await this.port.loadHistory(sessionId, this.signal)
    // A newer attachment started while we were loading: ignore this result.
    if (generation !== this.generation || this.closed) return
    if (!history.ok) {
      if (history.error.code === 'session-not-found') {
        this.setState({ attachment: emptyAttachment })
        const request = ++this.pickerRequest
        await this.refreshLists()
        // Re-assert the reason only when this reopen actually opened, so a
        // superseded reopen or a concurrent newer picker stays unclobbered.
        if (!this.closed && request === this.pickerRequest) {
          const project = this.state.selectedProject
          const rows = project === undefined
            ? []
            : sessionRows(
              this.rowsCache.workspaces,
              this.rowsCache.sessions,
              this.rowsCache.archived,
              project,
            )
          this.view.openSessionPicker(rows, (row) => { void this.attach(row.sessionId) }, () => this.view.closePicker())
          this.setState({ notice: 'Session no longer exists' })
        }
      } else {
        this.setState({
          attachment: emptyAttachment,
          notice: history.error.message,
        })
      }
      return
    }
    // Fold the history tail, then the events buffered while it loaded, under
    // the same overlap and continuity rules as live frames.
    const projected = projectEvents(history.value.events.map((entry) => entry.event))
    const attachment = this.state.attachment
    const buffered = attachment.phase === 'loading' && attachment.sessionId === sessionId && attachment.generation === generation
      ? attachment.buffered
      : []
    let lastSeq = projected.lastSeq
    let transcript = projected.rows
    let partial = projected.partial
    for (const event of buffered) {
      if (event.seq <= lastSeq) continue
      if (event.seq !== lastSeq + 1) {
        this.setState({
          attachment: emptyAttachment,
          connection: 'disconnected',
          notice: 'Disconnected: sequence gap',
        })
        return
      }
      const next = applyEvent({ rows: transcript, partial, lastSeq }, event)
      lastSeq = next.lastSeq
      transcript = next.rows
      partial = next.partial
    }
    // The connection may have died while history was loading (gap, stream
    // end, stream/error, flood): do not claim a live attachment or clear
    // the disconnect instruction in that case.
    if (this.state.connection !== 'connected') {
      this.setState({ attachment: emptyAttachment })
      return
    }
    this.setState({
      attachment: {
        phase: 'attached',
        sessionId,
        generation,
        lastSeq,
        transcript,
        partial,
        sending: false,
      },
      notice: undefined,
    })
  }

  /**
   * Submit plain text to the attached session. Requires an attached session
   * on a connected stream, non-blank text, and no in-flight submission;
   * slash-command input is rejected locally and retained. The original text
   * is sent unsanitized through session.prompt in queue mode.
   */
  async submit(text: string): Promise<SubmitResult> {
    const attachment = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || attachment.phase !== 'attached'
      || attachment.sending) {
      return { ok: false, reason: 'not-attached' }
    }
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, reason: 'blank' }
    if (trimmed.startsWith('/')) {
      // Design: slash commands are rejected locally, the text is retained,
      // and the footer instruction is surfaced.
      this.setState({ notice: 'Slash commands require the Web UI' })
      return { ok: false, reason: 'slash-command' }
    }
    const generation = attachment.generation
    const sessionId = attachment.sessionId
    this.setState({ attachment: { ...attachment, sending: true } })
    const result = await this.port.prompt(sessionId, text, this.signal)
    // A switch, shutdown, or disconnect while in flight: drop the late result
    // entirely so it cannot overwrite the disconnect notice.
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.generation !== generation
      || current.sessionId !== sessionId) {
      // Clear the in-flight flag so the stale result cannot wedge sending.
      if (current.phase === 'attached') {
        this.setState({ attachment: { ...current, sending: false } })
      }
      return { ok: false, reason: 'stale' }
    }
    this.setState({ attachment: { ...current, sending: false } })
    if (!result.ok) {
      this.setState({ notice: result.error.message })
      return { ok: false, reason: 'rejected', error: result.error.message }
    }
    // The design doc's prompt-submission flow: show a transient accepted
    // notice and never append a transcript row (the logged user/message
    // event on the mux stream renders the prompt itself). The notice clears
    // when that echo arrives, even if it beats the unary response.
    this.pendingAccepted = generation
    this.setState({ notice: 'Accepted by DSH' })
    return { ok: true }
  }

  /** Idempotent shutdown: stop the view and settle the stream pump. */
  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.view.stop()
  }

  /** Await the stream pump's settlement (used by the CLI lifecycle). */
  async waitForPump(): Promise<void> {
    await this.streamPump
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    this.view.render(this.state)
  }
}

/** Upper bound on waiting for the mux stream's physical onOpen at boot. */
export const STREAM_READY_TIMEOUT_MS = 10_000

/** Upper bound on events buffered while history loads (a history round-trip
 *  needs only the frames between the request and its response). */
const MAX_BUFFERED_EVENTS = 10_000

/** Submit outcome: accepted, or a reason (with the safe error when rejected). */
export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'not-attached' | 'blank' | 'slash-command' | 'stale' | 'rejected'; error?: string }

/** Boot result: success carries the host description; failure carries the safe error. */
export type RpcBootResult =
  | { ok: true; host: HostDescription }
  | { ok: false; error: { code: string; message: string } }
