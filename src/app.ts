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

import type { ModelReasoning, MuxFrame, QueuedInboxItem, RpcId, SessionModels } from '@deepseek-ai/dsh-host-apiproxy/api'

import type { DshPort, HostDescription } from './dsh.js'
import { applyEvent, projectEvents, type PartialAssistant, type TranscriptRow } from './transcript.js'

/** Sentinel picker row: selecting it opens the create-project path input. */
export const CREATE_PROJECT = '\u0000create-project'
/** Sentinel picker row: selecting it creates a session in the current project. */
export const CREATE_SESSION = '\u0000create-session'

/** A pickable project row: the special "All sessions" bucket, one Workspace,
 *  or the create-project action row. */
export type ProjectRow = {
  key: WorkspaceId | 'all' | typeof CREATE_PROJECT
  title: string
}

/** A pickable session row for the current project filter (or the
 *  create-session action row). */
export interface SessionRow {
  sessionId: SessionId | typeof CREATE_SESSION
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

/** A pending approval request from the host, keyed by its echoed rpcId. */
export interface PendingApproval {
  rpcId: RpcId
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

/** One selectable model (or, with effortId, one reasoning effort) row. */
export interface ModelChoice {
  provider: string
  model: string
  name: string
  description?: string
  /** Present when this row chooses a reasoning effort. */
  effortId?: string
  /** Exact-route reasoning metadata when the model exposes efforts. */
  reasoning?: ModelReasoning
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
      /** Open approval requests from the host (approval/requested frames not
       *  yet settled by approval/resolved). */
      pendingApprovals: readonly PendingApproval[]
      /** The session's current model selection label (Provider · Model
       *  (effort)), refreshed at attach and after every selectModel. */
      modelLabel: string | undefined
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
  /** Modal path field for the create-project flow: Enter submits, ESC cancels. */
  openCreateProjectInput(onSubmit: (path: string) => void, onCancel: () => void): void
  openModelPicker(choices: readonly ModelChoice[], onSelect: (choice: ModelChoice) => void, onCancel: () => void): void
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

/** The plain text of a queued message: the first text content part, raw
 *  (the display and editor paths sanitize at the edge with
 *  terminalSafeText, so the wire copy stays verbatim). */
export function queuedItemText(item: QueuedInboxItem): string {
  const content = item.message.content
  const part = content?.find((candidate) => candidate.type === 'text' && typeof candidate.text === 'string')
  return part !== undefined && part.type === 'text' ? part.text : ''
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
  const parts = trimmed.split(',').map((part) => part.trim()).filter((part) => part !== '')
  return questions.map((question) => {
    const options = question.options ?? []
    // The custom remainder is the non-numeric text plus any out-of-range
    // numbers, so nothing typed is silently dropped.
    const outOfRange = options.length > 0 ? numbers.filter((n) => n < 1 || n > options.length) : []
    const rest = [...new Set(parts.filter((part) => !/^\d+$/.test(part))), ...outOfRange.map(String)].join(', ')
    if (numbers.length > 0 && options.length > 0) {
      let selected = numbers
        .filter((n) => n >= 1 && n <= options.length)
        .map((n) => options[n - 1]?.label ?? '')
        .filter((label) => label !== '')
      // Single-select questions take the first valid option only (the host
      // rejects multi-selections for them); the custom remainder covers the
      // non-numeric text and out-of-range numbers, so the only drop is the
      // surplus in-range numbers the question cannot accept.
      if (question.multiSelect !== true && selected.length > 1) selected = selected.slice(0, 1)
      // A number that matches no option must not silently produce an empty
      // answer: fall back to a custom answer with the typed text.
      if (selected.length > 0) {
        // The reference's panel attaches the focused option AND the typed
        // text, and the host schema allows selected + custom together, so
        // the non-numeric remainder rides along for both select modes.
        if (rest !== '') return { id: question.id, selected, custom: rest }
        return { id: question.id, selected }
      }
    }
    const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase())
    if (exact !== undefined) return { id: question.id, selected: [exact.label] }
    return { id: question.id, selected: [], custom: trimmed }
  })
}

/** Footer stats from the session list snapshot; undefined when the host
 *  projection lacks token or context numbers. */
/** The display label for a model selection: "Provider · Model (effort)"
 *  from the catalog, falling back to the raw ids when the current selection
 *  is not in the advertised groups (catalog membership is advisory). */
export function modelLabelFor(models: SessionModels): string {
  const current = models.current
  const group = models.groups.find((candidate) => candidate.id === current.provider)
  const model = group?.models.find((candidate) => candidate.id === current.model)
  const name = group === undefined || model === undefined
    ? `${current.provider}/${current.model}`
    : `${group.name} · ${model.name}`
  const effortId = current.reasoningEffort
  if (effortId === undefined) return name
  const effort = model?.reasoning?.efforts.find((candidate) => candidate.id === effortId)
  return `${name} (${effort?.name ?? effortId})`
}

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
            ? this.state.notice ?? 'Disconnected: restart dsh-shell to reconnect'
            : 'Disconnected: restart dsh-shell to reconnect',
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
          ? this.state.notice ?? 'Disconnected: restart dsh-shell to reconnect'
          : 'Disconnected: restart dsh-shell to reconnect',
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
        // Bound the pending list like MAX_BUFFERED_EVENTS: the host settles
        // sequentially — it waits on the OLDEST ask — so a flood must keep
        // the oldest entries, or the early asks become unreachable.
        const questions = [...entry.questions, pending]
        return { ...entry, questions: questions.slice(0, MAX_PENDING_QUESTIONS) }
      })
      return
    }
    if (frame.type === 'question/resolved') {
      this.updateInbox(frame.sessionId, (entry) => ({
        ...entry,
        questions: entry.questions.filter((question) => question.rpcId !== frame.questionRpcId),
      }))
      // The transient Answered notice has no echo of its own; the host's
      // settle frame is it.
      if (this.state.notice === 'Answered') this.setState({ notice: undefined })
      return
    }
    if (frame.type === 'approval/requested') {
      if (frame.rpcId === undefined) return
      const pending: PendingApproval = {
        rpcId: frame.rpcId,
        approvalId: String(frame.approvalId),
        toolName: frame.toolName,
        ...(frame.callId === undefined ? {} : { callId: frame.callId }),
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      }
      this.updateInbox(frame.sessionId, (entry) => {
        // Dedupe by approvalId (the audit correlation): a mux replay of the
        // same ask carries the same approvalId with a fresh rpcId, and the
        // resolved frame settles by approvalId too.
        if (entry.approvals.some((approval) => approval.approvalId === pending.approvalId)) return entry
        // The host settles sequentially, so a flood must keep the oldest
        // entries, or the early asks become unreachable.
        const approvals = [...entry.approvals, pending]
        return { ...entry, approvals: approvals.slice(0, MAX_PENDING_APPROVALS) }
      })
      return
    }
    if (frame.type === 'approval/resolved') {
      this.updateInbox(frame.sessionId, (entry) => ({
        ...entry,
        approvals: entry.approvals.filter((approval) => approval.approvalId !== String(frame.approvalId)),
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
    update: (entry: { queue: readonly QueuedInboxItem[]; questions: readonly PendingQuestion[]; approvals: readonly PendingApproval[] }) => { queue: readonly QueuedInboxItem[]; questions: readonly PendingQuestion[]; approvals: readonly PendingApproval[] },
  ): void {
    const key = String(sessionId)
    const entry = update(this.inbox.get(key) ?? { queue: [], questions: [], approvals: [] })
    if (entry.queue.length === 0 && entry.questions.length === 0 && entry.approvals.length === 0) {
      this.inbox.delete(key)
    } else {
      this.inbox.set(key, entry)
    }
    const attachment = this.state.attachment
    if (attachment.phase === 'attached' && String(attachment.sessionId) === key) {
      this.setState({
        attachment: {
          ...attachment,
          queue: entry.queue,
          pendingQuestions: entry.questions,
          pendingApprovals: entry.approvals,
        },
      })
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
  /** The last sessions.models catalog: resolves display names for the
   *  current-selection label and for labels after selectModel. */
  private modelCatalog: SessionModels | undefined

  /** Refresh the footer's model label after an attach (the host pushes
   *  model changes only through the projection, so the label is fetched).
   *  Failures are silent: the label simply stays absent. */
  private async refreshModel(sessionId: SessionId, generation: number): Promise<void> {
    const result = await this.port.listModels(sessionId, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.sessionId !== sessionId
      || current.generation !== generation) {
      return
    }
    if (!result.ok) return
    this.modelCatalog = result.value
    this.setState({ attachment: { ...current, modelLabel: modelLabelFor(result.value) } })
  }

  private inbox = new Map<string, {
    queue: readonly QueuedInboxItem[]
    questions: readonly PendingQuestion[]
    approvals: readonly PendingApproval[]
  }>()

  /** Open the project picker over the given rows: the trailing create row
   *  opens the path-entry modal (ESC returns to the refreshed picker). */
  private showProjectPicker(rows: readonly ProjectRow[]): void {
    this.view.openProjectPicker(rows, (row) => {
      if (row.key === CREATE_PROJECT) {
        // Path entry modal; ESC returns to the refreshed project picker.
        this.view.openCreateProjectInput(
          (path) => { void this.createProject(path) },
          () => { void this.openProjectPicker() },
        )
        return
      }
      void this.selectProject(row)
    }, () => this.view.closePicker())
  }

  /** Ctrl+P: open the project picker (refreshes both lists first). A
   *  trailing create row opens the path-entry modal. */
  async openProjectPicker(): Promise<void> {
    const request = ++this.pickerRequest
    await this.refreshLists()
    if (this.closed || request !== this.pickerRequest) return
    this.showProjectPicker([
      ...this.state.projects,
      { key: CREATE_PROJECT, title: '＋ Create new project' },
    ])
  }

  /** Ctrl+S (or after a project pick): open the session picker for the current project. */
  async openSessionPicker(): Promise<void> {
    const request = ++this.pickerRequest
    await this.refreshLists()
    if (this.closed || request !== this.pickerRequest) return
    const project = this.state.selectedProject
    if (project === undefined) {
      // No project yet (Ctrl+S before any pick): show the project picker
      // with its create action so creation stays reachable.
      this.showProjectPicker([
        ...this.state.projects,
        { key: CREATE_PROJECT, title: '＋ Create new project' },
      ])
      return
    }
    const rows: readonly SessionRow[] = [
      ...sessionRows(
        this.rowsCache.workspaces,
        this.rowsCache.sessions,
        this.rowsCache.archived,
        project,
      ),
      { sessionId: CREATE_SESSION, title: '＋ Create new session' },
    ]
    this.view.openSessionPicker(rows, (row) => {
      if (row.sessionId === CREATE_SESSION) {
        void this.createSession()
        return
      }
      void this.attach(row.sessionId)
    }, () => this.view.closePicker())
  }

  /** Remember the chosen project and immediately open its session picker.
   *  The create-project row never reaches here (the picker branches on it). */
  async selectProject(row: ProjectRow): Promise<void> {
    if (this.closed || row.key === CREATE_PROJECT) return
    this.view.closePicker()
    this.setState({ selectedProject: row.key })
    await this.openSessionPicker()
  }

  /** Create a project over an existing directory, then open its session
   *  picker. A write: never retried; a failure surfaces a notice and reopens
   *  the (refreshed) project picker so the attempt can be redone or
   *  abandoned. */
  async createProject(path: string): Promise<void> {
    if (this.closed) return
    // A dead stream cannot create (and then attach): mirror attach's guard
    // so the write is not issued into the void.
    if (this.state.connection !== 'connected') {
      this.setState({ notice: 'Disconnected: restart dsh-shell to reconnect' })
      return
    }
    const trimmed = path.trim()
    if (trimmed === '') {
      // Enter on an empty path cancels like ESC: back to the picker.
      await this.openProjectPicker()
      return
    }
    const result = await this.port.createWorkspace(trimmed, this.signal)
    if (this.closed) return
    if (!result.ok) {
      // A stream death mid-write keeps the disconnect notice (the reopen's
      // own refresh would clobber it with an RPC error).
      if (this.state.connection !== 'connected') return
      // Reopen first: the picker's own refresh clears stale notices, so the
      // error is set after it to survive.
      await this.openProjectPicker()
      if (!this.closed) this.setState({ notice: `Create project failed: ${result.error.message}` })
      return
    }
    this.setState({ selectedProject: result.value.workspace.workspaceId })
    await this.openSessionPicker()
  }

  /** Create a session in the selected project — or the host cwd when the
   *  picker was under All sessions — and attach to it immediately: the fresh
   *  session starts blank and the composer is ready to prompt. */
  async createSession(): Promise<void> {
    if (this.closed) return
    // A dead stream cannot attach the fresh session: keep the picker open
    // and explain, so a write cannot orphan a blank session on the host.
    if (this.state.connection !== 'connected') {
      this.setState({ notice: 'Disconnected: restart dsh-shell to reconnect' })
      return
    }
    this.view.closePicker()
    const project = this.state.selectedProject
    const workspaceId = project === undefined || project === 'all' ? undefined : project
    const result = await this.port.createSession(workspaceId, this.signal)
    if (this.closed) return
    if (!result.ok) {
      // A stream death mid-write keeps the disconnect notice (the reopen's
      // own refresh would clobber it with an RPC error).
      if (this.state.connection !== 'connected') return
      // Reopen first: the picker's own refresh clears stale notices, so the
      // error is set after it to survive.
      await this.openSessionPicker()
      if (!this.closed) this.setState({ notice: `Create session failed: ${result.error.message}` })
      return
    }
    await this.attach(result.value.sessionId)
  }

  /** Attach to a session: load one tail history page and project it. */
  async attach(sessionId: SessionId): Promise<void> {
    if (this.closed) return
    if (this.state.connection !== 'connected') {
      // A dead stream cannot attach; keep the picker open and explain.
      this.setState({ notice: 'Disconnected: restart dsh-shell to reconnect' })
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
          const rows: readonly SessionRow[] = project === undefined
            ? []
            : [
              ...sessionRows(
                this.rowsCache.workspaces,
                this.rowsCache.sessions,
                this.rowsCache.archived,
                project,
              ),
              { sessionId: CREATE_SESSION, title: '＋ Create new session' },
            ]
          this.view.openSessionPicker(rows, (row) => {
            if (row.sessionId === CREATE_SESSION) {
              void this.createSession()
              return
            }
            void this.attach(row.sessionId)
          }, () => this.view.closePicker())
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
        // Pre-attach queue/question/approval frames (mux replay) seed the
        // attachment.
        queue: this.inbox.get(String(sessionId))?.queue ?? [],
        pendingQuestions: this.inbox.get(String(sessionId))?.questions ?? [],
        pendingApprovals: this.inbox.get(String(sessionId))?.approvals ?? [],
        modelLabel: undefined,
      },
      notice: undefined,
    })
    // The model label is fetched separately (sessions.models); failures are
    // silent, so the label may stay absent.
    void this.refreshModel(sessionId, generation)
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
    // the per-session cache in step so a later re-attach sees no ghost. The
    // resolved frame can beat the receipt: then the entry is already gone,
    // its notice-clearing already ran, and a new 'Answered' notice would
    // stick — so only show it when the request is still pending.
    const alreadySettled = !current.pendingQuestions.some((question) => question.rpcId === pending.rpcId)
    const remaining = current.pendingQuestions.filter((question) => question.rpcId !== pending.rpcId)
    this.setState({
      attachment: { ...current, sending: false, pendingQuestions: remaining },
      ...(alreadySettled ? {} : { notice: 'Answered' }),
    })
    const cached = this.inbox.get(String(sessionId))
    if (cached !== undefined) {
      const questions = cached.questions.filter((question) => question.rpcId !== pending.rpcId)
      if (questions.length === 0 && cached.queue.length === 0) this.inbox.delete(String(sessionId))
      else this.inbox.set(String(sessionId), { ...cached, questions })
    }
    return { ok: true }
  }

  /** Answer the first pending approval with the given outcome
   *  ('allowed-once' or 'rejected'): echo the request's rpcId on
   *  /api/respond with the approval payload. */
  async answerApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const attachment = this.state.attachment
    if (this.closed || this.state.connection !== 'connected' || attachment.phase !== 'attached') return
    const pending = attachment.pendingApprovals.find((approval) => approval.approvalId === approvalId)
    if (pending === undefined) return
    const sessionId = attachment.sessionId
    const generation = attachment.generation
    const receipt = await this.port.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId, approvalId, outcome } },
    }, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.sessionId !== sessionId
      || current.generation !== generation) {
      return
    }
    if (!receipt.accepted) {
      this.setState({ notice: receipt.reason === 'not-pending' ? 'Approval already decided' : 'Approval not accepted' })
      return
    }
    // The host settles with approval/resolved; drop the pending entry now so
    // the card clears immediately, and keep the cache in step.
    const remaining = current.pendingApprovals.filter((approval) => approval.approvalId !== approvalId)
    this.setState({ attachment: { ...current, pendingApprovals: remaining } })
    const cached = this.inbox.get(String(sessionId))
    if (cached !== undefined) {
      const approvals = cached.approvals.filter((approval) => approval.approvalId !== approvalId)
      if (approvals.length === 0 && cached.queue.length === 0 && cached.questions.length === 0) {
        this.inbox.delete(String(sessionId))
      } else {
        this.inbox.set(String(sessionId), { ...cached, approvals })
      }
    }
  }

  /** Ctrl+M: open the model picker for the attached session. Choosing a
   *  model that exposes reasoning efforts chains into an effort picker, then
   *  applies the selection via sessions.selectModel. */
  async openModelPicker(): Promise<void> {
    const attachment = this.state.attachment
    if (this.closed || this.state.connection !== 'connected' || attachment.phase !== 'attached') return
    const sessionId = attachment.sessionId
    const generation = attachment.generation
    const result = await this.port.listModels(sessionId, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.sessionId !== sessionId
      || current.generation !== generation) {
      return
    }
    if (!result.ok) {
      this.setState({ notice: result.error.message })
      return
    }
    const models = result.value
    this.modelCatalog = models
    const currentKey = `${models.current.provider}/${models.current.model}`
    const choices: ModelChoice[] = []
    for (const group of models.groups) {
      for (const model of group.models) {
        choices.push({
          provider: group.id,
          model: model.id,
          name: `${group.name} · ${model.name}${`${group.id}/${model.id}` === currentKey ? ' (current)' : ''}`,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        })
      }
    }
    if (choices.length === 0) {
      this.setState({ notice: 'No models available' })
      return
    }
    this.view.openModelPicker(choices, (choice) => {
      const efforts = choice.reasoning?.efforts ?? []
      if (efforts.length === 0) {
        void this.selectModel(sessionId, { provider: choice.provider, model: choice.model })
        return
      }
      // A model with efforts chains into an effort picker; the Default row
      // omits reasoningEffort so the adapter/provider default applies.
      const effortChoices: ModelChoice[] = [
        { provider: choice.provider, model: choice.model, name: 'Default' },
        ...efforts.map((effort) => ({
          provider: choice.provider,
          model: choice.model,
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
          effortId: effort.id,
        })),
      ]
      this.view.openModelPicker(effortChoices, (effortChoice) => {
        void this.selectModel(sessionId, {
          provider: effortChoice.provider,
          model: effortChoice.model,
          ...(effortChoice.effortId === undefined ? {} : { reasoningEffort: effortChoice.effortId }),
        })
      }, () => this.view.closePicker())
    }, () => this.view.closePicker())
  }

  /** Apply the chosen model (and optional effort); the notice echoes the
   *  selection. */
  private async selectModel(sessionId: SessionId, selection: {
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<void> {
    const attachment = this.state.attachment
    if (this.closed || this.state.connection !== 'connected' || attachment.phase !== 'attached') return
    const generation = attachment.generation
    const result = await this.port.selectModel(sessionId, selection, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.sessionId !== sessionId
      || current.generation !== generation) {
      return
    }
    if (!result.ok) {
      this.setState({ notice: result.error.message })
      return
    }
    const effort = selection.reasoningEffort === undefined ? '' : ` (${selection.reasoningEffort})`
    const label = this.modelCatalog === undefined
      ? `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` (${selection.reasoningEffort})`}`
      : modelLabelFor({
        ...this.modelCatalog,
        current: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
      })
    this.setState({
      attachment: { ...current, modelLabel: label },
      notice: `Model: ${selection.model}${effort}`,
    })
  }

  /** Steer the last queued message into the running agent: the host removes
   *  it from the queue and steers the agent with it immediately, then
   *  broadcasts a fresh session/queue snapshot. Rejected with
   *  steer-unavailable when no turn accepts steering. */
  async steerQueuedItem(): Promise<boolean> {
    const attachment = this.state.attachment
    if (this.closed || this.state.connection !== 'connected' || attachment.phase !== 'attached') return false
    const queued = attachment.queue.filter((item) => item.placement === 'queued')
    const last = queued.at(-1)
    if (last === undefined) return false
    const sessionId = attachment.sessionId
    const generation = attachment.generation
    const result = await this.port.updateQueue(sessionId, last.id, { kind: 'steer' }, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.sessionId !== sessionId
      || current.generation !== generation) {
      return false
    }
    if (!result.ok) {
      this.setState({ notice: result.error.message })
      return false
    }
    return true
  }

  /** Pop the last queued message back into the composer (Codex's edit-last-
   *  queued): remove it from the host queue and return its raw text, or
   *  undefined when there is nothing queued or the removal is rejected. */
  async editQueuedItem(): Promise<string | undefined> {
    const attachment = this.state.attachment
    if (this.closed || this.state.connection !== 'connected' || attachment.phase !== 'attached') return undefined
    const queued = attachment.queue.filter((item) => item.placement === 'queued')
    const last = queued.at(-1)
    if (last === undefined) return undefined
    const sessionId = attachment.sessionId
    const generation = attachment.generation
    const result = await this.port.updateQueue(sessionId, last.id, { kind: 'remove' }, this.signal)
    const current = this.state.attachment
    if (this.closed
      || this.state.connection !== 'connected'
      || current.phase !== 'attached'
      || current.sessionId !== sessionId
      || current.generation !== generation) {
      return undefined
    }
    if (!result.ok) {
      this.setState({ notice: result.error.message })
      return undefined
    }
    // The host follows up with a fresh session/queue snapshot; nothing to
    // mutate locally.
    return queuedItemText(last)
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

/** Upper bound on open question requests held per session (a flood of
 *  question/requested frames must not grow the inbox without limit). */
const MAX_PENDING_QUESTIONS = 16

/** Upper bound on open approval requests held per session. */
const MAX_PENDING_APPROVALS = 8

/** Submit outcome: accepted, or a reason (with the safe error when rejected). */
export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'not-attached' | 'blank' | 'slash-command' | 'stale' | 'rejected'; error?: string }

/** Boot result: success carries the host description; failure carries the safe error. */
export type RpcBootResult =
  | { ok: true; host: HostDescription }
  | { ok: false; error: { code: string; message: string } }
