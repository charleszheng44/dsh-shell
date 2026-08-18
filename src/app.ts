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

import type { MuxFrame, QueuedInboxItem, RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

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

/** Usage snapshot shown in the footer while attached (pi-style stats). */
export interface SessionStats {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextWindow: number
  pressureTokens: number
}

/** One selectable answer offered to the user (dsh-user-questions shape). */
export interface QuestionOption {
  label: string
  description?: string
}

/** One question in an ask_user_question request (structural subset). */
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: readonly QuestionOption[]
  multiSelect?: boolean
}

/** A pending question request from the host, keyed by its echoed rpcId. */
export interface PendingQuestion {
  rpcId: RpcId
  questions: readonly QuestionItem[]
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
      title: string
      generation: number
      buffered: SessionEvent[]
    }
  | {
      phase: 'attached'
      sessionId: SessionId
      title: string
      generation: number
      lastSeq: number
      transcript: readonly TranscriptRow[]
      partial: PartialAssistant | undefined
      sending: boolean
      /** Tool-call ids seen in this attachment, mapped to their names. */
      pendingTools: Readonly<Record<string, string>>
      /** The open turn's number on this attachment; the view shows the Deep
       *  diving status while a turn is running. */
      turnActive: number | undefined
      /** Token/context snapshot from the session list, for the footer. */
      stats: SessionStats | undefined
      /** Transient inbox snapshot from session/queue frames: prompts submitted
       *  but not yet claimed by the agent. */
      queue: readonly QueuedInboxItem[]
      /** Open question requests from the host (question/requested frames not
       *  yet settled by question/resolved). */
      pendingQuestions: readonly PendingQuestion[]
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

/** One question answer payload part, as the host's schema expects it. */
export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** Turn a typed answer into per-question answers: a number (or comma list)
 *  picks options by position, an exact option label picks that option, and
 *  anything else becomes a custom answer. */
export function parseQuestionAnswers(questions: readonly QuestionItem[], input: string): QuestionAnswerItem[] {
  const trimmed = input.trim()
  const numbers = [...new Set(trimmed.split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part))
    .map(Number))]
  return questions.map((question) => {
    const options = question.options ?? []
    if (numbers.length > 0 && options.length > 0) {
      let selected = numbers
        .filter((n) => n >= 1 && n <= options.length)
        .map((n) => options[n - 1]?.label ?? '')
        .filter((label) => label !== '')
      // Single-select questions take the first valid option only (the host
      // rejects multi-selections for them).
      if (question.multiSelect !== true && selected.length > 1) selected = selected.slice(0, 1)
      // A number that matches no option must not silently produce an empty
      // answer: fall back to a custom answer with the typed text.
      if (selected.length > 0) return { id: question.id, selected }
    }
    const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase())
    if (exact !== undefined) return { id: question.id, selected: [exact.label] }
    return { id: question.id, selected: [], custom: trimmed }
  })
}

/** Footer stats from the session list snapshot; undefined when the host
 *  projection lacks token or context numbers. */
export function summaryStats(session: SessionSummary | undefined): SessionStats | undefined {
  if (session === undefined) return undefined
  const values = session.projections?.values
  if (values === undefined) return undefined
  // The published projection map does not type host-registered keys beyond
  // the title; read token/context numbers structurally.
  const projected = values as unknown as {
    tokenUsage?: { uncachedInputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
    contextPressure?: { pressureTokens?: unknown; contextWindow?: unknown }
  }
  const usage = projected.tokenUsage
  const pressure = projected.contextPressure
  const number = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  )
  const uncachedInputTokens = number(usage?.uncachedInputTokens)
  const outputTokens = number(usage?.outputTokens)
  const cacheReadTokens = number(usage?.cacheReadTokens)
  const cacheWriteTokens = number(usage?.cacheWriteTokens)
  const pressureTokens = number(pressure?.pressureTokens)
  const contextWindow = number(pressure?.contextWindow)
  if (uncachedInputTokens === undefined || outputTokens === undefined || pressureTokens === undefined || contextWindow === undefined || contextWindow <= 0) {
    return undefined
  }
  return {
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    pressureTokens,
    contextWindow,
  }
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
  private onFrame(frame: MuxFrame & { rpcId?: RpcId }): void {
    // Once closed or disconnected, no further frame may mutate the view.
    if (this.closed || this.state.connection !== 'connected') return
    if (frame.type === 'stream/error') {
      this.setState({ connection: 'disconnected', notice: 'Disconnected: stream error' })
      this.streamAborted = true
      return
    }
    if (frame.type === 'session/queue') {
      // Transient inbox snapshot: prompts submitted but not yet claimed by
      // the agent. Cached per session so a replay before attach is still
      // shown once the session is attached.
      this.updateInbox(frame.sessionId, (entry) => ({ ...entry, queue: frame.items }))
      return
    }
    if (frame.type === 'question/requested') {
      if (frame.rpcId === undefined) return
      const pending: PendingQuestion = {
        rpcId: frame.rpcId,
        questions: frame.questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.options === undefined ? {} : { options: question.options }),
          ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
        })),
      }
      this.updateInbox(frame.sessionId, (entry) => {
        if (entry.questions.some((question) => question.rpcId === pending.rpcId)) return entry
        return { ...entry, questions: [...entry.questions, pending] }
      })
      return
    }
    if (frame.type === 'question/resolved') {
      this.updateInbox(frame.sessionId, (entry) => ({
        ...entry,
        questions: entry.questions.filter((question) => question.rpcId !== frame.questionRpcId),
      }))
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
      {
        rows: attachment.transcript,
        partial: attachment.partial,
        lastSeq: attachment.lastSeq,
        pendingTools: attachment.pendingTools,
        turnActive: attachment.turnActive,
      },
      frame.event,
    )
    this.setState({
      attachment: {
        ...attachment,
        lastSeq: next.lastSeq,
        transcript: next.rows,
        partial: next.partial,
        pendingTools: next.pendingTools,
        turnActive: next.turnActive,
      },
    })
    // A finished turn is a stats boundary: the footer's token and context
    // numbers come from the session-list projection, so re-snapshot them
    // instead of freezing the attach-time values for the whole attachment.
    if (frame.event.type === 'turn/end') void this.refreshStats()
  }

  /** Apply a queue/question update to the per-session inbox cache, and to
   *  the attachment when the frame belongs to the attached session. Empty
   *  snapshots prune the cache entry. */
  private updateInbox(
    sessionId: SessionId,
    update: (entry: { queue: readonly QueuedInboxItem[]; questions: readonly PendingQuestion[] }) => { queue: readonly QueuedInboxItem[]; questions: readonly PendingQuestion[] },
  ): void {
    const key = String(sessionId)
    const entry = update(this.inbox.get(key) ?? { queue: [], questions: [] })
    if (entry.queue.length === 0 && entry.questions.length === 0) {
      this.inbox.delete(key)
    } else {
      this.inbox.set(key, entry)
    }
    const attachment = this.state.attachment
    if (attachment.phase === 'attached' && String(attachment.sessionId) === key) {
      this.setState({ attachment: { ...attachment, queue: entry.queue, pendingQuestions: entry.questions } })
    }
  }

  /** Monotonic token so an older in-flight stats refresh can never overwrite
   *  a newer one (rapid turn/ends fire overlapping listSessions calls). */
  private statsRefreshSeq = 0

  /** Re-snapshot the attached session's footer stats after a live turn/end.
   *  Failures are silent: the previous snapshot stays, and a superseded
   *  attachment, a newer refresh, or a disconnect discards the late result. */
  private async refreshStats(): Promise<void> {
    const attachment = this.state.attachment
    if (this.closed || this.state.connection !== 'connected' || attachment.phase !== 'attached') return
    const sessionId = attachment.sessionId
    const generation = attachment.generation
    const seq = ++this.statsRefreshSeq
    const result = await this.port.listSessions(this.signal)
    if (this.closed || this.state.connection !== 'connected' || seq !== this.statsRefreshSeq) return
    const current = this.state.attachment
    if (current.phase !== 'attached' || current.sessionId !== sessionId || current.generation !== generation) return
    if (!result.ok) return
    const summary = result.value.items.find((candidate) => candidate.sessionId === sessionId)
    this.setState({ attachment: { ...current, stats: summaryStats(summary) } })
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

  /** Transient inbox state cached per session from mux replays and updates:
   *  queue and question frames can arrive before the user attaches (the host
   *  replays them on stream open), and the attachment seeds from this cache. */
  private inbox = new Map<string, { queue: readonly QueuedInboxItem[]; questions: readonly PendingQuestion[] }>()

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
    // The header shows the picker's title (falling back to the id), and the
    // footer shows the token/context snapshot from the session list.
    const summary = this.rowsCache.sessions.find((candidate) => candidate.sessionId === sessionId)
    const title = this.state.sessions.find((candidate) => candidate.sessionId === sessionId)?.title
      ?? String(sessionId)
    const stats = summaryStats(summary)
    this.setState({
      attachment: { phase: 'loading', sessionId, title, generation, buffered: [] },
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
    let pendingTools = projected.pendingTools
    let turnActive = projected.turnActive
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
      const next = applyEvent({ rows: transcript, partial, lastSeq, pendingTools, turnActive }, event)
      lastSeq = next.lastSeq
      transcript = next.rows
      partial = next.partial
      pendingTools = next.pendingTools
      turnActive = next.turnActive
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
        title,
        generation,
        lastSeq,
        transcript,
        partial,
        sending: false,
        pendingTools,
        turnActive,
        stats,
        // Pre-attach queue/question frames (mux replay) seed the attachment.
        queue: this.inbox.get(String(sessionId))?.queue ?? [],
        pendingQuestions: this.inbox.get(String(sessionId))?.questions ?? [],
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
    // While a question is open, the composer answers the question instead of
    // queuing a prompt: a number (or comma-separated numbers) selects options,
    // text that matches an option label selects it, anything else is a custom
    // answer. The echoed rpcId settles the host's pending request.
    const pending = attachment.pendingQuestions[0]
    if (pending !== undefined) {
      return this.answerQuestion(attachment, pending, trimmed)
    }
    if (trimmed.startsWith('/')) {
      // Design: slash commands are rejected locally, the text is retained,
      // and the footer instruction is surfaced. Disarm any pending accepted
      // marker so a late echo from an earlier submission cannot wipe the
      // instruction notice.
      if (this.pendingAccepted === attachment.generation) this.pendingAccepted = undefined
      this.setState({ notice: 'Slash commands require the Web UI' })
      return { ok: false, reason: 'slash-command' }
    }
    const generation = attachment.generation
    const sessionId = attachment.sessionId
    // Arm the accepted-notice marker before the call: the prompt's own
    // user/message echo can arrive on the mux while the unary is still in
    // flight, and the echo must clear the notice regardless of ordering.
    this.pendingAccepted = generation
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
      // Clear the in-flight flag only when the attachment is still this one:
      // a newer attachment's in-flight submission must not be unwedged by a
      // late result from an older generation. Skip the render after
      // shutdown (the view is stopped; render would be a no-op).
      if (!this.closed && current.phase === 'attached' && current.generation === generation) {
        this.setState({ attachment: { ...current, sending: false } })
      }
      if (this.pendingAccepted === generation) this.pendingAccepted = undefined
      return { ok: false, reason: 'stale' }
    }
    this.setState({ attachment: { ...current, sending: false } })
    if (!result.ok) {
      // Disarm so a late echo from this attempt cannot wipe the error notice.
      if (this.pendingAccepted === generation) this.pendingAccepted = undefined
      this.setState({ notice: result.error.message })
      return { ok: false, reason: 'rejected', error: result.error.message }
    }
    // The design doc's prompt-submission flow: show a transient accepted
    // notice and never append a transcript row (the logged user/message
    // event on the mux stream renders the prompt itself). The notice clears
    // when that echo arrives; if the echo already arrived (it can beat the
    // unary response) it cleared the marker and the notice, so do not show
    // it again. One marker per attachment generation is an approximation:
    // echoes carry no submission identity, so with two rapid submissions a
    // delayed echo from the first can consume the marker of the second and
    // suppress its notice. Cosmetic — the echo renders the prompt row
    // either way.
    if (this.pendingAccepted === generation) {
      this.setState({ notice: 'Accepted by DSH' })
    }
    return { ok: true }
  }

  /** Answer the first open question: build the answer payload from the typed
   *  text and echo the request's rpcId on /api/respond. The editor clears on
   *  acceptance; a rejection keeps the text and shows the notice. */
  private async answerQuestion(
    attachment: Extract<AttachmentState, { phase: 'attached' }>,
    pending: PendingQuestion,
    text: string,
  ): Promise<SubmitResult> {
    const sessionId = attachment.sessionId
    const generation = attachment.generation
    this.setState({ attachment: { ...attachment, sending: true } })
    const answers = parseQuestionAnswers(pending.questions, text)
    const receipt = await this.port.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId, answer: { answers } } },
    }, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.generation !== generation
      || current.sessionId !== sessionId) {
      if (!this.closed && current.phase === 'attached' && current.generation === generation) {
        this.setState({ attachment: { ...current, sending: false } })
      }
      return { ok: false, reason: 'stale' }
    }
    this.setState({ attachment: { ...current, sending: false } })
    if (!receipt.accepted) {
      this.setState({ notice: receipt.reason === 'not-pending' ? 'Question already answered' : 'Answer not accepted' })
      return { ok: false, reason: 'rejected', error: 'answer not accepted' }
    }
    // The host settles the request with question/resolved; drop the pending
    // entry now so the card and the answer mode clear immediately, and keep
    // the per-session cache in step so a later re-attach sees no ghost.
    const remaining = current.pendingQuestions.filter((question) => question.rpcId !== pending.rpcId)
    this.setState({ attachment: { ...current, sending: false, pendingQuestions: remaining }, notice: 'Answered' })
    const cached = this.inbox.get(String(sessionId))
    if (cached !== undefined) {
      const questions = cached.questions.filter((question) => question.rpcId !== pending.rpcId)
      if (questions.length === 0 && cached.queue.length === 0) this.inbox.delete(String(sessionId))
      else this.inbox.set(String(sessionId), { ...cached, questions })
    }
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
