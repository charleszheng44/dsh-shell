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
import type {} from '@deepseek-ai/dsh-session-title/types'

import type { DshPort, HostDescription } from './dsh.js'
import { projectEvents, type PartialAssistant, type TranscriptRow } from './transcript.js'

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
  if (workspace === undefined) return sessions
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const ordered: SessionSummary[] = []
  for (const sessionId of workspace.sessionIds) {
    const session = byId.get(sessionId)
    if (session !== undefined) ordered.push(session)
  }
  // Sessions attached to this project that the workspace list has not
  // materialized yet stay reachable at the end rather than disappearing.
  for (const session of sessions) {
    if (!ordered.includes(session)) ordered.push(session)
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
    projects: [],
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

  constructor(
    private readonly port: DshPort,
    private readonly view: AppView,
    private readonly signal: AbortSignal,
  ) {}

  getState(): AppState {
    return this.state
  }

  /** Startup: describe, mark connected, refresh lists, open the project picker. */
  async boot(): Promise<RpcBootResult> {
    this.setState({ connection: 'connecting' })
    const describe = await this.port.describe(this.signal)
    if (!describe.ok) {
      return { ok: false, error: describe.error }
    }
    this.setState({ connection: 'connected' })
    await this.refreshLists()
    await this.openProjectPicker()
    return { ok: true, host: describe.value }
  }

  /** Re-fetch both lists; a failure keeps the current rows and surfaces a notice. */
  async refreshLists(): Promise<void> {
    const [workspaces, sessions] = await Promise.all([
      this.port.listWorkspaces(this.signal),
      this.port.listSessions(this.signal),
    ])
    if (!workspaces.ok) {
      this.setState({ notice: workspaces.error.message })
      return
    }
    if (!sessions.ok) {
      this.setState({ notice: sessions.error.message })
      return
    }
    this.setState({
      projects: projectRows(workspaces.value.items),
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
    await this.refreshLists()
    const rows = this.state.projects
    this.view.openProjectPicker(rows, (row) => { void this.selectProject(row) }, () => this.view.closePicker())
  }

  /** Ctrl+S (or after a project pick): open the session picker for the current project. */
  async openSessionPicker(): Promise<void> {
    await this.refreshLists()
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
    this.view.closePicker()
    this.setState({ selectedProject: row.key })
    await this.openSessionPicker()
  }

  /** Attach to a session: load one tail history page and project it. */
  async attach(sessionId: SessionId): Promise<void> {
    this.view.closePicker()
    const generation = ++this.generation
    this.setState({
      attachment: { phase: 'loading', sessionId, generation, buffered: [] },
    })
    const history = await this.port.loadHistory(sessionId, this.signal)
    // A newer attachment started while we were loading: ignore this result.
    if (generation !== this.generation || this.closed) return
    if (!history.ok) {
      if (history.error.code === 'session-not-found') {
        this.setState({
          attachment: emptyAttachment,
          notice: 'Session no longer exists',
        })
        await this.openSessionPicker()
      } else {
        this.setState({
          attachment: emptyAttachment,
          notice: history.error.message,
        })
      }
      return
    }
    const projected = projectEvents(history.value.events.map((entry) => entry.event))
    this.setState({
      attachment: {
        phase: 'attached',
        sessionId,
        generation,
        lastSeq: projected.lastSeq,
        transcript: projected.rows,
        partial: projected.partial,
        sending: false,
      },
      notice: undefined,
    })
  }

  /** Idempotent shutdown: stop the view and drop future work. */
  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.view.stop()
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    this.view.render(this.state)
  }
}

/** Boot result: success carries the host description; failure carries the safe error. */
export type RpcBootResult =
  | { ok: true; host: HostDescription }
  | { ok: false; error: { code: string; message: string } }
