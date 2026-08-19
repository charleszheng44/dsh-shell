/**
 * PR 3 commit C tests: the live mux stream — delayed readiness, buffering
 * during history load, other-session frame isolation, attachment switches,
 * overlap deduplication, sequence-gap disconnects, history-plus-live
 * stitching, stream error, and abort-driven shutdown with no pending handle.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MuxFrame, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

import { App, type AppView, type AppState } from '../src/app.js'
import type { DshPort } from '../src/dsh.js'

class FakeView implements AppView {
  renders: AppState[] = []
  projectPickerRows: AppState['projects'] | undefined
  sessionPickerRows: AppState['sessions'] | undefined
  stopped = 0

  render(state: AppState): void {
    this.renders.push(state)
  }

  openProjectPicker(rows: AppState['projects']): void {
    this.projectPickerRows = rows
  }

  openSessionPicker(rows: AppState['sessions']): void {
    this.sessionPickerRows = rows
  }

  closePicker(): void {
    this.projectPickerRows = undefined
    this.sessionPickerRows = undefined
  }

  stop(): void {
    this.stopped += 1
  }
}

class FakePort implements DshPort {
  describeResult: ReturnType<DshPort['describe']> = Promise.resolve({
    ok: true,
    value: {
      version: '0.0.1',
      cwd: '/tmp',
      attachedSessions: 0,
      canOpenPath: false,
    } as never,
  })
  workspaces = []
  archived: unknown[] = []
  sessions = []
  historyEvents: Record<string, SessionEvent[]> = {}
  /** Frames pushed by the test; delivered when the consumer polls. */
  pendingFrames: MuxFrame[] = []
  /** If true, stream never opens (readiness hangs until abort). */
  neverOpens = false
  /** If true, the stream throws immediately. */
  throwsOnOpen = false
  private waiters: Array<() => void> = []
  private ended = false
  private opened = false
  private signal: AbortSignal | undefined
  onOpened: (() => void) | undefined

  describe(signal?: AbortSignal): ReturnType<DshPort['describe']> {
    return this.describeResult
  }

  async listWorkspaces(): Promise<Awaited<ReturnType<DshPort['listWorkspaces']>>> {
    return { ok: true, value: { items: this.workspaces as never, archivedSessionIds: this.archived as never } }
  }

  async listSessions(): Promise<Awaited<ReturnType<DshPort['listSessions']>>> {
    return { ok: true, value: { items: this.sessions as never } }
  }

  async loadHistory(sessionId: string): Promise<Awaited<ReturnType<DshPort['loadHistory']>>> {
    const events = this.historyEvents[String(sessionId)]
    if (events === undefined) {
      return { ok: false, error: { code: 'session-not-found', message: 'gone', details: { sessionId } as never } }
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

  async prompt(sessionId: string, text: string): Promise<Awaited<ReturnType<DshPort['prompt']>>> {
    this.promptCalls.push({ sessionId: String(sessionId), text })
    return this.promptResult
  }

  async *stream(signal: AbortSignal, onOpen: () => void): AsyncIterable<MuxFrame> {
    this.signal = signal
    if (signal.aborted) {
      this.ended = true
      return
    }
    if (this.throwsOnOpen) throw new Error('stream exploded')
    if (this.neverOpens) {
      // Hang until abort, mirroring the real client's socket never opening.
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          this.ended = true
          resolve()
        }, { once: true })
      })
      return
    }
    this.opened = true
    this.onOpened = onOpen
    onOpen()
    while (!this.ended) {
      while (this.pendingFrames.length > 0) {
        const frame = this.pendingFrames.shift()
        if (frame !== undefined) yield frame
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        signal.addEventListener('abort', () => {
          this.ended = true
          this.wake()
        }, { once: true })
      })
    }
  }

  push(frame: MuxFrame): void {
    this.pendingFrames.push(frame)
    this.wake()
  }

  end(): void {
    this.ended = true
    this.wake()
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

function freshAbort(): AbortController {
  return new AbortController()
}

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

function sessionFrame(sessionId: string, ev: SessionEvent): MuxFrame {
  return { type: 'session/event', sessionId: sessionId as never, event: ev } as unknown as MuxFrame
}

function userText(seq: number, text: string): SessionEvent {
  return {
    ...event(seq, 'user/message', {
      id: `m-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  } as unknown as SessionEvent
}

/** Flush the async generator's frame delivery before asserting. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function chunk(seq: number, chunkPayload: unknown): SessionEvent {
  return event(seq, 'assistant/chunk', { turn: 0, step: 0, chunk: chunkPayload }) as SessionEvent
}

async function booted(port: FakePort): Promise<{ app: App; view: FakeView }> {
  const view = new FakeView()
  const app = new App(port, view, new AbortController().signal)
  const result = await app.boot()
  assert.equal(result.ok, true)
  return { app, view }
}

test('boot awaits stream readiness before marking connected', async () => {
  const port = new FakePort()
  port.neverOpens = true
  const controller = new AbortController()
  const view = new FakeView()
  const app = new App(port, view, controller.signal)
  const boot = app.boot()
  // Give any eager code a chance to run; readiness must not resolve.
  await Promise.resolve()
  assert.equal(view.renders.at(-1)?.connection, 'connecting')
  // Abort releases the hung stream and boot fails cleanly.
  controller.abort()
  const result = await boot
  assert.equal(result.ok, false)
})

test('boot marks connected when a delayed onOpen fires', async () => {
  const port = new FakePort()
  let open: () => void = () => undefined
  const original = port.stream.bind(port)
  port.stream = async function* (signal: AbortSignal, onOpen: () => void): AsyncIterable<MuxFrame> {
    open = onOpen
    yield* original(signal, () => {})
  }
  const controller = new AbortController()
  const view = new FakeView()
  const app = new App(port, view, controller.signal)
  const boot = app.boot()
  // Readiness must not resolve before the physical open fires.
  await Promise.resolve()
  assert.equal(view.renders.at(-1)?.connection, 'connecting')
  open()
  const result = await boot
  assert.equal(result.ok, true)
  assert.equal(view.renders.at(-1)?.connection, 'connected')
})

test('events arriving during history load are buffered and folded contiguously', async () => {
  const port = new FakePort()
  port.historyEvents = {
    s1: [userText(1, 'question')],
  }
  const { app, view } = await booted(port)
  // Attach; while history is in flight, push live frames for the session.
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    // The original resolves later via releaseHistory; nothing else resolves.
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  port.push(sessionFrame('s1', userText(2, 'buffered prompt')))
  port.push(sessionFrame('s1', chunk(3, { type: 'text-delta', index: 0, text: 'live ' })))
  port.push(sessionFrame('s1', chunk(4, { type: 'text-delta', index: 0, text: 'delta' })))
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'question') }], hasMore: false } })
  await attach
  await flush()
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'connected')
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 4)
    assert.equal(last.attachment.transcript.length, 2)
    assert.equal(last.attachment.partial?.turn, 0)
  }
})

test('frames for another session are ignored', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push(sessionFrame('other', userText(9, 'intruder')))
  await flush()
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 1)
    assert.equal(last.attachment.transcript.length, 1)
  }
})

test('an other-session frame during history load is not buffered', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    void original(sessionId)
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  // An other-session frame while loading must not enter the buffer.
  port.push(sessionFrame('other', userText(9, 'intruder')))
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'q') }], hasMore: false } })
  await attach
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 1)
    assert.equal(last.attachment.transcript.length, 1)
  }
})

test('switching sessions during history load drops the stale generation', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'a')], s2: [userText(1, 'b')] }
  const { app, view } = await booted(port)
  let releaseS1: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => sessionId === 's1'
    ? new Promise((resolve) => { releaseS1 = resolve })
    : original(sessionId)
  const attachS1 = app.attach('s1' as never)
  await app.attach('s2' as never)
  releaseS1({ ok: true, value: { events: [{ event: userText(99, 'stale') }], hasMore: false } })
  await attachS1
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.sessionId, 's2')
    assert.equal(last.attachment.lastSeq, 1)
  }
})

test('buffered overlap is dropped and gaps disconnect', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  // Buffered event that overlaps history (seq 1) must be dropped.
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    // The original resolves later via releaseHistory; nothing else resolves.
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  port.push(sessionFrame('s1', userText(1, 'overlap')))
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'q') }], hasMore: false } })
  await attach
  const afterOverlap = view.renders.at(-1)
  assert.equal(afterOverlap?.connection, 'connected')

  // Steady-state gap (5 after 1) disconnects.
  port.push(sessionFrame('s1', userText(5, 'jump')))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
  assert.match(last?.notice ?? '', /gap/)
})

test('an initial buffered gap disconnects instead of attaching', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    // The original resolves later via releaseHistory; nothing else resolves.
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  port.push(sessionFrame('s1', userText(3, 'jump')))
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'q') }], hasMore: false } })
  await attach
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
  assert.equal(last?.attachment.phase, 'none')
})

test('history prefix plus live suffix stitches one transcript', async () => {
  const port = new FakePort()
  port.historyEvents = {
    s1: [
      userText(1, 'q'),
      chunk(2, { type: 'block-start', index: 0, blockType: 'text' }),
      chunk(3, { type: 'text-delta', index: 0, text: 'prefix ' }),
    ],
  }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push(sessionFrame('s1', chunk(4, { type: 'text-delta', index: 0, text: 'suffix' })))
  port.push(sessionFrame('s1', { type: 'assistant/message', seq: 5, time: 0, surfaceOp: 'append', data: {
    turn: 0,
    step: 0,
    message: {
      id: 'm5',
      role: 'assistant',
      content: [{ type: 'text', text: 'prefix suffix' }],
      source: { kind: 'model', provider: 'p' },
    },
  } } as never))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 5)
    assert.equal(last.attachment.partial, undefined)
    const assistant = last.attachment.transcript.at(-1)
    assert.deepEqual(assistant, {
      kind: 'assistant',
      segments: [{ kind: 'text', text: 'prefix suffix' }],
    })
  }
})

test('live tool/result folds into a named output row after a tool-call message', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  // The pendingTools map is populated by the live assistant/message and must
  // survive into the next live fold so the tool/result can be named.
  port.push(sessionFrame('s1', {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      message: {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'run_code', arguments: '{"code":"x"}' }],
        source: { kind: 'model', provider: 'p' },
      },
    },
  } as never))
  port.push(sessionFrame('s1', {
    type: 'tool/result',
    seq: 3,
    time: 0,
    data: {
      turn: 0,
      step: 0,
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'out' }] }],
      },
    },
  } as never))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 3)
    assert.deepEqual(last.attachment.transcript, [
      { kind: 'user', text: 'q' },
      { kind: 'toolCall', name: 'run_code', args: '{"code":"x"}' },
      { kind: 'toolResult', name: 'run_code', output: 'out', truncated: false, error: false },
    ])
  }
})

test('live turn/start and turn/end drive the working flag', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  const idle = view.renders.at(-1)?.attachment
  assert.equal(idle?.phase === 'attached' && idle.turnActive, undefined)
  port.push(sessionFrame('s1', { type: 'turn/start', seq: 2, time: 0, data: { turn: 0 } } as never))
  await flush()
  const opened = view.renders.at(-1)?.attachment
  assert.equal(opened?.phase === 'attached' && opened.turnActive, 0)
  port.push(sessionFrame('s1', { type: 'turn/end', seq: 3, time: 0, data: { turn: 0, reason: { kind: 'stop' } } } as never))
  await flush()
  const closed = view.renders.at(-1)?.attachment
  assert.equal(closed?.phase === 'attached' && closed.turnActive, undefined)
})

test('a live turn/end refreshes the footer stats snapshot', async () => {
  const port = new FakePort()
  const summaryWithStats = (usage: Record<string, unknown>): SessionSummary => ({
    sessionId: 's1' as never,
    updatedAt: 0,
    running: false,
    blank: false,
    projections: {
      asOfSeq: 1,
      values: {
        tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextPressure: { pressureTokens: 10, contextWindow: 1000 },
        ...usage,
      } as never,
    },
  })
  port.sessions = [summaryWithStats({})] as never
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  const before = view.renders.at(-1)?.attachment
  assert.equal(before?.phase === 'attached' && before.stats?.pressureTokens, 10)
  // The host's next list call reports grown usage.
  port.sessions = [summaryWithStats({ tokenUsage: { uncachedInputTokens: 5, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 } })] as never
  port.push(sessionFrame('s1', { type: 'turn/end', seq: 2, time: 0, data: { turn: 0, reason: { kind: 'stop' } } } as never))
  await flush()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const after = view.renders.at(-1)?.attachment
  assert.equal(after?.phase === 'attached' && after.stats?.outputTokens, 9)
  assert.equal(after?.phase === 'attached' && after.stats?.pressureTokens, 10)
})

test('a turn opened in history stays working until a buffered turn/end closes it', async () => {
  const port = new FakePort()
  port.historyEvents = {
    s1: [
      userText(1, 'q'),
      { type: 'turn/start', seq: 2, time: 0, data: { turn: 0 } } as never,
    ],
  }
  const { app, view } = await booted(port)
  // While history loads, the turn/end for the open turn arrives on the mux.
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    void original(sessionId)
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  port.push(sessionFrame('s1', { type: 'turn/end', seq: 3, time: 0, data: { turn: 0, reason: { kind: 'stop' } } } as never))
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'q') }, { event: { type: 'turn/start', seq: 2, time: 0, data: { turn: 0 } } as never }], hasMore: false } })
  await attach
  const last = view.renders.at(-1)?.attachment
  assert.equal(last?.phase === 'attached' && last.turnActive, undefined)
})

test('session/queue frames drive the attached queue snapshot', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  const queuedItem = (id: string, text: string, placement = 'queued') => ({
    id,
    placement,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [
    queuedItem('m1', 'fix the parser'),
    queuedItem('m2', 'run tests'),
  ] } as never)
  await flush()
  const updated = view.renders.at(-1)?.attachment
  assert.equal(updated?.phase === 'attached' && updated.queue.length, 2)
  if (updated?.phase === 'attached') {
    assert.equal(updated.queue[0]?.placement, 'queued')
  }
  // A queue snapshot for another session is ignored.
  port.push({ type: 'session/queue', sessionId: 'other' as never, items: [queuedItem('mx', 'intruder')] } as never)
  await flush()
  const afterOther = view.renders.at(-1)?.attachment
  assert.equal(afterOther?.phase === 'attached' && afterOther.queue.length, 2)
  // An empty snapshot drains the queue.
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [] } as never)
  await flush()
  const drained = view.renders.at(-1)?.attachment
  assert.equal(drained?.phase === 'attached' && drained.queue.length, 0)
})

test('a flood of question/requested frames is bounded per session', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  for (let i = 0; i < 30; i += 1) {
    port.push({ type: 'question/requested', sessionId: 's1' as never, rpcId: `rpc-${i}`, questions: [
      { id: `qa-${i}`, question: `Q${i}` },
    ] } as never)
  }
  await flush()
  const attached = view.renders.at(-1)?.attachment
  assert.equal(attached?.phase === 'attached' && attached.pendingQuestions.length, 16)
  if (attached?.phase === 'attached') {
    // The host settles the OLDEST ask first, so the cap must keep the head
    // of the queue, not the tail.
    assert.equal(attached.pendingQuestions[0]?.rpcId, 'rpc-0')
    assert.equal(attached.pendingQuestions[15]?.rpcId, 'rpc-15')
  }
})

test('queue and question frames that arrive before attach seed the attachment', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  // The host replays the inbox state on stream open, before any attach.
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [
    { id: 'm1', placement: 'queued', message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'queued prompt' }], source: { kind: 'user' } } },
  ] } as never)
  port.push({ type: 'question/requested', sessionId: 's1' as never, rpcId: 'rpc-q0', questions: [
    { id: 'qa', question: 'Approve?' },
  ] } as never)
  await flush()
  await app.attach('s1' as never)
  const attached = view.renders.at(-1)?.attachment
  assert.equal(attached?.phase, 'attached')
  if (attached?.phase === 'attached') {
    assert.equal(attached.queue.length, 1)
    assert.equal(attached.pendingQuestions.length, 1)
    assert.equal(attached.pendingQuestions[0]?.rpcId, 'rpc-q0')
  }
  // Empty snapshots prune the cache: a later attach seeds nothing.
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [] } as never)
  port.push({ type: 'question/resolved', sessionId: 's1' as never, questionRpcId: 'rpc-q0', outcome: 'cancelled' } as never)
  await flush()
})

test('question/requested and question/resolved frames drive pending questions', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push({ type: 'question/requested', sessionId: 's1' as never, rpcId: 'rpc-q1', questions: [
    { id: 'qa', question: 'Approve the change?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ] } as never)
  await flush()
  const asked = view.renders.at(-1)?.attachment
  assert.equal(asked?.phase === 'attached' && asked.pendingQuestions.length, 1)
  if (asked?.phase === 'attached') {
    assert.equal(asked.pendingQuestions[0]?.rpcId, 'rpc-q1')
    assert.equal(asked.pendingQuestions[0]?.questions[0]?.options?.[0]?.label, 'Yes')
  }
  // A replay with the same rpcId is not duplicated.
  port.push({ type: 'question/requested', sessionId: 's1' as never, rpcId: 'rpc-q1', questions: [
    { id: 'qa', question: 'Approve the change?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ] } as never)
  await flush()
  const replayed = view.renders.at(-1)?.attachment
  assert.equal(replayed?.phase === 'attached' && replayed.pendingQuestions.length, 1)
  // A question for another session is ignored.
  port.push({ type: 'question/requested', sessionId: 'other' as never, rpcId: 'rpc-q2', questions: [] } as never)
  await flush()
  const other = view.renders.at(-1)?.attachment
  assert.equal(other?.phase === 'attached' && other.pendingQuestions.length, 1)
  // question/resolved settles it.
  port.push({ type: 'question/resolved', sessionId: 's1' as never, questionRpcId: 'rpc-q1', outcome: 'answered' } as never)
  await flush()
  const settled = view.renders.at(-1)?.attachment
  assert.equal(settled?.phase === 'attached' && settled.pendingQuestions.length, 0)
})

test('stream end marks disconnected', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.end()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
  assert.match(last?.notice ?? '', /restart/)
})

test('stream throw marks disconnected', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  port.throwsOnOpen = true
  const view = new FakeView()
  const app = new App(port, view, new AbortController().signal)
  const boot = await app.boot()
  assert.equal(boot.ok, false)
  assert.equal(view.renders.at(-1)?.connection, 'disconnected')
})

test('a render throw rejects the pump, distinct from a stream failure', async () => {
  // The design failure table: "Render code throws -> Run the one shutdown
  // path, print the safe error, exit nonzero." The pump must rethrow the
  // render error (so the CLI's failure handlers run) instead of treating it
  // as a stream failure that merely marks disconnected.
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const view = new FakeView()
  const app = new App(port, view, new AbortController().signal)
  const boot = await app.boot()
  assert.equal(boot.ok, true)
  await app.attach('s1' as never)
  // The next live frame triggers a render failure.
  view.render = () => { throw new Error('render blew up') }
  port.push(sessionFrame('s1', userText(2, 'live')))
  await assert.rejects(() => app.waitForPump(), /render blew up/)
})

test('stream/error frame marks disconnected', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push({ type: 'stream/error', error: { code: 'internal', message: 'boom', details: {} } } as never)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
})

test('abort settles the pump with no pending stream handle', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const controller = new AbortController()
  const view = new FakeView()
  const app = new App(port, view, controller.signal)
  const boot = await app.boot()
  assert.equal(boot.ok, true)
  await app.attach('s1' as never)
  const pump = app.waitForPump()
  // Shutdown aborts the controller; the fake stream ends on abort like the
  // real WebSocket, so the pump settles with no pending handle.
  controller.abort()
  app.shutdown()
  await Promise.race([pump, new Promise((_, reject) => setTimeout(() => reject(new Error('pump hung')), 1000))])
})

test('empty history page accepts a first live event at seq 0', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] } // empty log, watermark -1
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push(sessionFrame('s1', userText(0, 'first')))
  await flush()
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'connected')
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 0)
    assert.equal(last.attachment.transcript.length, 1)
  }
})

test('a first live event at seq 1 after an empty log disconnects', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push(sessionFrame('s1', userText(1, 'jump')))
  await flush()
  assert.equal(view.renders.at(-1)?.connection, 'disconnected')
})

test('steady-state overlap is dropped without rendering a duplicate', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  const before = view.renders.at(-1)
  port.push(sessionFrame('s1', userText(1, 'duplicate')))
  await flush()
  const after = view.renders.at(-1)
  assert.equal(after?.connection, 'connected')
  if (before?.attachment.phase === 'attached' && after?.attachment.phase === 'attached') {
    assert.equal(after.attachment.transcript.length, before.attachment.transcript.length)
  }
})

test('a disconnect during history load does not install attached or clear the notice', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    void original(sessionId)
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  // The stream dies while history is loading.
  port.push({ type: 'stream/error', error: { code: 'internal', message: 'boom', details: {} } } as never)
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'q') }], hasMore: false } })
  await attach
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
  assert.equal(last?.attachment.phase, 'none')
  assert.match(last?.notice ?? '', /Disconnected/)
})

test('a flood during history load disconnects instead of attaching', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  let releaseHistory: (value: Awaited<ReturnType<DshPort['loadHistory']>>) => void = () => undefined
  const original = port.loadHistory.bind(port)
  port.loadHistory = (sessionId) => new Promise((resolve) => {
    releaseHistory = resolve
    void original(sessionId)
  })
  const attach = app.attach('s1' as never)
  await Promise.resolve()
  // Exceed the flood cap while loading.
  for (let seq = 2; seq <= 10_002; seq += 1) {
    port.push(sessionFrame('s1', userText(seq, `flood ${seq}`)))
  }
  await flush()
  releaseHistory({ ok: true, value: { events: [{ event: userText(1, 'q') }], hasMore: false } })
  await attach
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
  assert.equal(last?.attachment.phase, 'none')
  assert.match(last?.notice ?? '', /flood/)
})

test('attach while disconnected keeps the picker open and says why', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push({ type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } as never)
  await flush()
  await app.attach('s1' as never)
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'none')
  assert.match(last?.notice ?? '', /Disconnected/)
})

test('a gap in the attached phase stops the pump', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [userText(1, 'q')] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push(sessionFrame('s1', userText(9, 'jump')))
  await flush()
  assert.equal(view.renders.at(-1)?.connection, 'disconnected')
  // A later contiguous frame must not be applied (pump stopped).
  port.push(sessionFrame('s1', userText(10, 'after gap')))
  await flush()
  const last = view.renders.at(-1)
  assert.equal(last?.attachment.phase, 'attached')
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.lastSeq, 1)
  }
})
