/**
 * app.ts orchestration tests against an in-memory fake DshPort: boot failure
 * before selectors, project/session filtering and ordering, title fallback,
 * empty project selection, history business failure, stale attach
 * suppression, and idempotent shutdown.
 */

import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MuxFrame, SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api'

import { App, sessionRows, summaryStats, type AppState, type AppView, type ProjectRow } from '../src/app.js'
import type { DshPort } from '../src/dsh.js'
import type { HostDescription } from '../src/dsh.js'

function summary(partial: Partial<SessionSummary> & { sessionId: SessionId }): SessionSummary {
  return {
    updatedAt: 0,
    running: false,
    blank: false,
    ...partial,
  } as SessionSummary
}

function workspace(partial: Partial<WorkspaceView> & { workspaceId: WorkspaceView['workspaceId'] }): WorkspaceView {
  return {
    path: `/tmp/${partial.title ?? 'w'}`,
    title: partial.title ?? 'w',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...partial,
  } as WorkspaceView
}

/** Recording fake view. */
class FakeView implements AppView {
  renders: AppState[] = []
  projectPickerRows: readonly ProjectRow[] | undefined
  sessionPickerRows: AppState['sessions'] | undefined
  onProjectSelect: ((row: ProjectRow) => void) | undefined
  onSessionSelect: ((row: AppState['sessions'][number]) => void) | undefined
  stopped = 0

  render(state: AppState): void {
    this.renders.push(state)
  }

  openProjectPicker(rows: readonly ProjectRow[], onSelect: (row: ProjectRow) => void): void {
    this.projectPickerRows = rows
    this.onProjectSelect = onSelect
  }

  openSessionPicker(rows: readonly AppState['sessions'][number][], onSelect: (row: AppState['sessions'][number]) => void): void {
    this.sessionPickerRows = rows
    this.onSessionSelect = onSelect
  }

  closePicker(): void {
    this.projectPickerRows = undefined
    this.sessionPickerRows = undefined
  }

  stop(): void {
    this.stopped += 1
  }
}

/** In-memory fake of the exact DshPort seam. */
class FakePort implements DshPort {
  describeResult: ReturnType<DshPort['describe']> = Promise.resolve({
    ok: true,
    value: {
      version: '0.0.1',
      cwd: '/tmp',
      provider: 'p',
      model: 'm',
      attachedSessions: 0,
      canOpenPath: false,
    } as HostDescription,
  })
  workspaces: WorkspaceView[] = []
  archived: SessionId[] = []
  sessions: SessionSummary[] = []
  /** Per-session history events; absent sessionId means session-not-found. */
  historyEvents: Record<string, SessionEvent[]> = {}
  historyCalls: SessionId[] = []
  /** Push one mux frame to the stream consumer; frames buffer until pumped. */
  streamFrames: MuxFrame[] = []
  streamOpened = false
  streamEnded = false
  private streamWaiters: Array<() => void> = []
  private streamAbort: AbortSignal | undefined

  describe(signal?: AbortSignal): ReturnType<DshPort['describe']> {
    return this.describeResult
  }

  async listWorkspaces(): Promise<Awaited<ReturnType<DshPort['listWorkspaces']>>> {
    return { ok: true, value: { items: this.workspaces, archivedSessionIds: this.archived } }
  }

  async listSessions(): Promise<Awaited<ReturnType<DshPort['listSessions']>>> {
    return { ok: true, value: { items: this.sessions } }
  }

  async loadHistory(sessionId: SessionId): Promise<Awaited<ReturnType<DshPort['loadHistory']>>> {
    this.historyCalls.push(sessionId)
    const events = this.historyEvents[String(sessionId)]
    if (events === undefined) {
      return { ok: false, error: { code: 'session-not-found', message: 'gone', details: { sessionId } } }
    }
    return { ok: true, value: { events: events.map((event) => ({ event })), hasMore: false } }
  }

  promptCalls: Array<{ sessionId: string; text: string }> = []
  promptResult: Awaited<ReturnType<DshPort['prompt']>> = { ok: true, value: { accepted: true } }

  respondCalls: Array<{ rpcId: string; value: unknown }> = []

  updateQueueCalls: Array<{ sessionId: string; itemId: string; action: unknown }> = []
  updateQueueResult: Awaited<ReturnType<DshPort['updateQueue']>> = { ok: true, value: { accepted: true } }

  async updateQueue(sessionId: string, itemId: string, action: unknown): Promise<Awaited<ReturnType<DshPort['updateQueue']>>> {
    this.updateQueueCalls.push({ sessionId: String(sessionId), itemId: String(itemId), action })
    return this.updateQueueResult
  }
  respondResult: Awaited<ReturnType<DshPort['respond']>> = { accepted: true }

  async respond(message: Parameters<DshPort['respond']>[0]): Promise<Awaited<ReturnType<DshPort['respond']>>> {
    this.respondCalls.push({ rpcId: String(message.rpcId), value: message.result })
    return this.respondResult
  }

  async prompt(sessionId: SessionId, text: string): Promise<Awaited<ReturnType<DshPort['prompt']>>> {
    this.promptCalls.push({ sessionId: String(sessionId), text })
    return this.promptResult
  }

  async *stream(signal: AbortSignal, onOpen: () => void): AsyncIterable<MuxFrame> {
    this.streamAbort = signal
    signal.addEventListener('abort', () => {
      this.streamEnded = true
      this.notifyStream()
    }, { once: true })
    this.streamOpened = true
    onOpen()
    while (!this.streamEnded) {
      while (this.streamFrames.length > 0) {
        const frame = this.streamFrames.shift()
        if (frame !== undefined) yield frame
      }
      if (this.streamEnded) return
      await new Promise<void>((resolve) => { this.streamWaiters.push(resolve) })
    }
  }

  pushFrame(frame: MuxFrame): void {
    this.streamFrames.push(frame)
    this.notifyStream()
  }

  endStream(): void {
    this.streamEnded = true
    this.notifyStream()
  }

  private notifyStream(): void {
    for (const resolve of this.streamWaiters.splice(0)) resolve()
  }
}

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

const abort = new AbortController()

async function booted(port: FakePort): Promise<{ app: App; view: FakeView }> {
  const view = new FakeView()
  const app = new App(port, view, abort.signal)
  const result = await app.boot()
  assert.equal(result.ok, true)
  return { app, view }
}

test('boot failure exits before selectors open', async () => {
  const port = new FakePort()
  port.describeResult = Promise.resolve({
    ok: false,
    error: { code: 'internal', message: 'connection refused', details: {} },
  })
  const view = new FakeView()
  const app = new App(port, view, abort.signal)
  const result = await app.boot()
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error.message, /connection refused/)
  assert.equal(view.projectPickerRows, undefined)
  assert.equal(view.renders.at(-1)?.connection, 'connecting')
})

test('boot opens the project picker with All sessions first', async () => {
  const port = new FakePort()
  port.workspaces = [
    workspace({ workspaceId: 'w1' as never, title: 'beta' }),
    workspace({ workspaceId: 'w2' as never, title: 'alpha' }),
  ]
  const { view } = await booted(port)
  assert.deepEqual(view.projectPickerRows?.map((row) => row.title), ['All sessions', 'beta', 'alpha'])
  assert.equal(view.renders.at(-1)?.connection, 'connected')
})

test('session rows hide archived, subagent, and blank sessions', () => {
  const sessions = [
    summary({ sessionId: 's1' as never, origin: 'subagent' }),
    summary({ sessionId: 's2' as never, blank: true }),
    summary({ sessionId: 's3' as never }),
    summary({ sessionId: 's4' as never }),
  ]
  const rows = sessionRows([], sessions, ['s4' as never], 'all')
  assert.deepEqual(rows.map((row) => row.sessionId), ['s3'])
})

test('All sessions preserves session.list order (newest first)', () => {
  const sessions = [
    summary({ sessionId: 'newest' as never }),
    summary({ sessionId: 'middle' as never }),
    summary({ sessionId: 'oldest' as never }),
  ]
  const rows = sessionRows([], sessions, [], 'all')
  assert.deepEqual(rows.map((row) => row.sessionId), ['newest', 'middle', 'oldest'])
})

test('workspace rows preserve the workspace sessionIds order', () => {
  const sessions = [
    summary({ sessionId: 'a' as never }),
    summary({ sessionId: 'b' as never }),
    summary({ sessionId: 'c' as never }),
  ]
  const ws = workspace({ workspaceId: 'w1' as never, title: 'project', sessionIds: ['c' as never, 'a' as never] })
  const rows = sessionRows([ws], sessions, [], ws.workspaceId)
  assert.deepEqual(rows.map((row) => row.sessionId), ['c', 'a'])
})

test('workspace picker never leaks other workspaces sessions', () => {
  const sessions = [
    summary({ sessionId: 'a' as never }),
    summary({ sessionId: 'b' as never }),
  ]
  const wsA = workspace({ workspaceId: 'wA' as never, title: 'A', sessionIds: ['a' as never] })
  const wsB = workspace({ workspaceId: 'wB' as never, title: 'B', sessionIds: ['b' as never] })
  const rows = sessionRows([wsA, wsB], sessions, [], wsA.workspaceId)
  assert.deepEqual(rows.map((row) => row.sessionId), ['a'])
})

test('title fallback: projection title, then cwd basename, then session id', () => {
  const titled = summary({ sessionId: 's1' as never })
  titled.projections = { asOfSeq: 1, values: { title: 'Nice title' } as never }
  assert.equal(sessionRows([], [titled], [], 'all')[0]?.title, 'Nice title')

  const cwd = summary({ sessionId: 's2' as never, cwd: '/Users/me/projects/intentlab' })
  assert.equal(sessionRows([], [cwd], [], 'all')[0]?.title, 'intentlab')

  const bare = summary({ sessionId: 's3' as never })
  assert.equal(sessionRows([], [bare], [], 'all')[0]?.title, 's3')
})

test('title fallback handles trailing-slash and Windows-style cwds', () => {
  // A trailing slash must not produce an empty basename.
  const trailing = summary({ sessionId: 's4' as never, cwd: '/Users/me/projects/intentlab/' })
  assert.equal(sessionRows([], [trailing], [], 'all')[0]?.title, 'intentlab')

  // A Windows-style cwd falls back through the platform's node:path basename
  // (the exact string differs per platform, so compare against it directly).
  const windowsCwd = 'C:\\Users\\me\\projects\\intentlab'
  const win = summary({ sessionId: 's5' as never, cwd: windowsCwd })
  assert.equal(sessionRows([], [win], [], 'all')[0]?.title, basename(windowsCwd))
})

test('empty project opens the session picker with no rows and never creates a session', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'empty', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never, blank: true })]
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'empty' })
  assert.deepEqual(view.sessionPickerRows ?? [], [])
  assert.equal(port.historyCalls.length, 0)
})

test('summaryStats reads token and context numbers structurally', () => {
  const withStats = summary({
    sessionId: 's1' as never,
    projections: {
      asOfSeq: 1,
      values: {
        title: 'T',
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
        contextPressure: { pressureTokens: 200, contextWindow: 1000 },
      } as never,
    },
  })
  assert.deepEqual(summaryStats(withStats), {
    uncachedInputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 30,
    cacheWriteTokens: 20,
    pressureTokens: 200,
    contextWindow: 1000,
  })
  // Missing projections, partial numbers, and non-finite numbers mean no stats.
  assert.equal(summaryStats(summary({ sessionId: 's2' as never })), undefined)
  assert.equal(summaryStats(undefined), undefined)
  const partial = summary({
    sessionId: 's3' as never,
    projections: { asOfSeq: 1, values: { tokenUsage: { outputTokens: 1 } } as never },
  })
  assert.equal(summaryStats(partial), undefined)
  const nan = summary({
    sessionId: 's4' as never,
    projections: {
      asOfSeq: 1,
      values: {
        tokenUsage: { uncachedInputTokens: Number.NaN, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextPressure: { pressureTokens: 1, contextWindow: 1000 },
      } as never,
    },
  })
  assert.equal(summaryStats(nan), undefined)
  // A non-positive context window is degenerate: no stats line.
  const zero = summary({
    sessionId: 's5' as never,
    projections: {
      asOfSeq: 1,
      values: {
        tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextPressure: { pressureTokens: 0, contextWindow: 0 },
      } as never,
    },
  })
  assert.equal(summaryStats(zero), undefined)
  // Negative token counts are rejected too.
  const negative = summary({
    sessionId: 's6' as never,
    projections: {
      asOfSeq: 1,
      values: {
        tokenUsage: { uncachedInputTokens: -5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextPressure: { pressureTokens: 10, contextWindow: 1000 },
      } as never,
    },
  })
  assert.equal(summaryStats(negative), undefined)
})

test('attach carries the picker title and the footer stats snapshot', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] })]
  port.sessions = [summary({
    sessionId: 's1' as never,
    projections: {
      asOfSeq: 1,
      values: {
        title: 'Nice title',
        tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextPressure: { pressureTokens: 30, contextWindow: 1000 },
      } as never,
    },
  })]
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  const attach = app.attach('s1' as never)
  // The loading phase already carries the title.
  const loading = view.renders.at(-1)
  assert.equal(loading?.attachment.phase === 'loading' && loading.attachment.title, 'Nice title')
  await attach
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.title, 'Nice title')
    assert.deepEqual(last.attachment.stats, {
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      pressureTokens: 30,
      contextWindow: 1000,
    })
  }
  // A session with no projection falls back to the id and no stats.
  port.historyEvents = { s2: [] }
  port.sessions = [summary({ sessionId: 's2' as never })]
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s2' as never] })]
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  await app.attach('s2' as never)
  const bare = view.renders.at(-1)
  assert.equal(bare?.attachment.phase, 'attached')
  if (bare?.attachment.phase === 'attached') {
    assert.equal(bare.attachment.title, 's2')
    assert.equal(bare.attachment.stats, undefined)
  }
})

test('disappeared session returns to the session selector with a notice', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never })]
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  await app.attach('s1' as never)
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'none')
  assert.equal(last?.notice, 'Session no longer exists')
  // Session picker reopened with the same rows: retry is possible.
  assert.ok(view.sessionPickerRows !== undefined)
})

test('stale attach suppression: late history from an older generation is ignored', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never, 's2' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never }), summary({ sessionId: 's2' as never })]
  // s1 resolves slowly; s2 resolves immediately.
  let resolveS1: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  port.historyEvents = { s1: [], s2: [] }
  const original = port.loadHistory.bind(port)
  port.loadHistory = async (sessionId) => {
    if (sessionId === 's1') {
      return new Promise<Awaited<ReturnType<DshPort['loadHistory']>>>((resolve) => { resolveS1 = resolve })
    }
    return original(sessionId)
  }

  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  const attachS1 = app.attach('s1' as never)
  await app.attach('s2' as never)
  resolveS1({ ok: true, value: { events: [], hasMore: false } })
  await attachS1

  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.sessionId, 's2')
    assert.equal(last.attachment.generation, 2)
  }
})

test('attach renders a loading phase while history is in flight', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    void original(sessionId)
  })
  const { app, view } = await booted(port)
  const attach = app.attach('s1' as never)
  assert.equal(view.renders.at(-1)?.attachment.phase, 'loading')
  releaseHistory({ ok: true, value: { events: [], hasMore: false } })
  await attach
  assert.equal(view.renders.at(-1)?.attachment.phase, 'attached')
})

test('shutdown during a history load renders nothing further', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    void original(sessionId)
  })
  const { app, view } = await booted(port)
  const attach = app.attach('s1' as never)
  const rendersAfterAttach = view.renders.length
  app.shutdown()
  releaseHistory({ ok: true, value: { events: [], hasMore: false } })
  await attach
  assert.equal(view.renders.length, rendersAfterAttach)
})

test('list failure keeps the current rows and shows the safe error', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never })]
  const { app, view } = await booted(port)
  port.listWorkspaces = async () => {
    return { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  }
  await app.openProjectPicker()
  const last = view.renders.at(-1)
  assert.equal(last?.notice, 'boom')
  assert.ok(view.projectPickerRows !== undefined)
})

test('sessions-list failure keeps the current rows and shows the safe error', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never })]
  const { app, view } = await booted(port)
  port.listSessions = async () => {
    return { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  }
  await app.openProjectPicker()
  const last = view.renders.at(-1)
  assert.equal(last?.notice, 'boom')
  // The previously fetched projects remain selectable: retry is possible.
  assert.deepEqual(view.projectPickerRows?.map((row) => row.title), ['All sessions', 'p'])
})

test('shutdown is idempotent', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  app.shutdown()
  app.shutdown()
  assert.equal(view.stopped, 1)
})

test('boot keeps the All sessions bucket when the first list refresh fails', async () => {
  const port = new FakePort()
  port.listWorkspaces = async () => {
    return { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  }
  const view = new FakeView()
  const app = new App(port, view, abort.signal)
  const result = await app.boot()
  assert.equal(result.ok, true)
  assert.deepEqual(view.projectPickerRows?.map((row) => row.title), ['All sessions'])
  assert.equal(view.renders.at(-1)?.notice, 'boom')
})

test('generic history error resets the attachment and keeps the notice without reopening the picker', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never })]
  port.loadHistory = async () => {
    return { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  }
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  const pickerClosedAfterProject = view.sessionPickerRows === undefined
  await app.attach('s1' as never)
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'none')
  assert.equal(last?.notice, 'boom')
  // No picker was reopened for a generic error (unlike session-not-found).
  assert.equal(view.sessionPickerRows, undefined)
  void pickerClosedAfterProject
})

test('concurrent picker opens: only the newest request opens an overlay', async () => {
  const port = new FakePort()
  port.workspaces = [
    workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] }),
  ]
  port.sessions = [summary({ sessionId: 's1' as never })]
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  view.closePicker()
  // Gate every listWorkspaces call until both picker opens are in flight.
  const waiters: Array<() => void> = []
  const original = port.listWorkspaces.bind(port)
  port.listWorkspaces = async () => {
    await new Promise<void>((resolve) => { waiters.push(resolve) })
    return original()
  }
  const p1 = app.openProjectPicker()
  const p2 = app.openSessionPicker()
  for (const resolve of waiters.splice(0)) resolve()
  await Promise.all([p1, p2])
  // The session picker (opened second, request 2) wins; the stale project
  // picker open from request 1 must not have rendered.
  assert.equal(view.projectPickerRows, undefined)
  assert.ok(view.sessionPickerRows !== undefined)
})

test('a superseded refresh cannot clobber newer rows or notices', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'A', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never })]
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'A' })
  view.closePicker()
  // First refresh hangs; second refresh succeeds with a fresh workspace list.
  const gate = new Set<() => void>()
  const original = port.listWorkspaces.bind(port)
  port.listWorkspaces = async () => {
    await new Promise<void>((resolve) => { gate.add(resolve) })
    return original()
  }
  const stale = app.openProjectPicker()
  const newer = app.openProjectPicker() // newer request; also gated
  for (const resolve of [...gate]) resolve()
  await Promise.all([stale, newer])
  // The newer refresh's rows are what the picker shows.
  assert.ok(view.projectPickerRows !== undefined)
  assert.equal(view.projectPickerRows?.length, 2) // All sessions + w1
})

test('attach ignores a request made after shutdown', async () => {
  const port = new FakePort()
  port.workspaces = [workspace({ workspaceId: 'w1' as never, title: 'p', sessionIds: ['s1' as never] })]
  port.sessions = [summary({ sessionId: 's1' as never })]
  const { app, view } = await booted(port)
  app.shutdown()
  await app.attach('s1' as never)
  assert.equal(view.renders.at(-1)?.attachment.phase, 'none')
})
