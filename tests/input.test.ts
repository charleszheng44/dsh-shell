/**
 * PR 3 commit D tests: plain-text submission — one Enter produces one prompt
 * call for the selected branded SessionId, blank and slash-command input make
 * no call, concurrent submission is blocked, acceptance clears the editor
 * without adding a transcript row, rejection preserves text, a late
 * old-session response cannot alter the new view, and disconnected state
 * disables submission.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

import { App, CREATE_PROJECT, CREATE_SESSION, parseQuestionAnswers, type AppState, type AppView, type ModelChoice, type ProjectRow, type SessionRow } from '../src/app.js'
import type { DshPort } from '../src/dsh.js'

class FakeView implements AppView {
  renders: AppState[] = []
  render(state: AppState): void { this.renders.push(state) }
  projectPickerRows: readonly ProjectRow[] | undefined
  onProjectSelect: ((row: ProjectRow) => void) | undefined
  sessionPickerRows: readonly SessionRow[] | undefined
  onSessionSelect: ((row: SessionRow) => void) | undefined
  openProjectPicker(rows: readonly ProjectRow[], onSelect: (row: ProjectRow) => void): void {
    this.projectPickerRows = rows
    this.onProjectSelect = onSelect
  }
  openSessionPicker(rows: readonly SessionRow[], onSelect: (row: SessionRow) => void): void {
    this.sessionPickerRows = rows
    this.onSessionSelect = onSelect
  }
  createInputPicks: Array<{ onSubmit: (path: string) => void; onCancel: () => void }> = []
  openCreateProjectInput(onSubmit: (path: string) => void, onCancel: () => void): void {
    this.createInputPicks.push({ onSubmit, onCancel })
  }
  closePicker(): void {
    this.projectPickerRows = undefined
    this.sessionPickerRows = undefined
  }
  modelPicks: Array<{ choices: readonly ModelChoice[]; onSelect: (choice: ModelChoice) => void; onCancel: () => void }> = []
  openModelPicker(choices: readonly ModelChoice[], onSelect: (choice: ModelChoice) => void, onCancel: () => void): void {
    this.modelPicks.push({ choices, onSelect, onCancel })
  }

  stop(): void {}
}

class FakePort implements DshPort {
  workspaces: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }> = []
  sessions: Array<{ sessionId: string; blank?: boolean; origin?: string; cwd?: string; projections?: unknown }> = []
  historyEvents: Record<string, SessionEvent[]> = {}
  promptCalls: Array<{ sessionId: string; text: string; mode: string }> = []
  promptResult: Awaited<ReturnType<DshPort['prompt']>> = { ok: true, value: { accepted: true } }

  respondCalls: Array<{ rpcId: string; value: unknown }> = []

  listModelsCalls: Array<string> = []
  listModelsResult: Awaited<ReturnType<DshPort['listModels']>> = {
    ok: true,
    value: { current: { provider: 'p', model: 'm' }, routable: true, groups: [], failures: [] },
  }

  selectModelCalls: Array<{ sessionId: string; selection: unknown }> = []
  selectModelResult: Awaited<ReturnType<DshPort['selectModel']>> = {
    ok: true,
    value: { selected: { provider: 'p', model: 'm' } },
  }

  async listModels(sessionId: string): Promise<Awaited<ReturnType<DshPort['listModels']>>> {
    this.listModelsCalls.push(String(sessionId))
    return this.listModelsResult
  }

  async selectModel(sessionId: string, selection: unknown): Promise<Awaited<ReturnType<DshPort['selectModel']>>> {
    this.selectModelCalls.push({ sessionId: String(sessionId), selection })
    return this.selectModelResult
  }

  createWorkspaceCalls: Array<string> = []
  createWorkspaceResult: Awaited<ReturnType<DshPort['createWorkspace']>> = {
    ok: true,
    value: { workspace: { workspaceId: 'w-new', path: '/tmp/newproj', title: 'newproj', sessionIds: [], createdAt: '', updatedAt: '' } as never, created: true },
  }

  async createWorkspace(path: string): Promise<Awaited<ReturnType<DshPort['createWorkspace']>>> {
    this.createWorkspaceCalls.push(path)
    return this.createWorkspaceResult
  }

  createSessionCalls: Array<{ workspaceId: string | undefined }> = []
  createSessionResult: Awaited<ReturnType<DshPort['createSession']>> = { ok: true, value: { sessionId: 's-new' as never } }

  async createSession(workspaceId: string | undefined): Promise<Awaited<ReturnType<DshPort['createSession']>>> {
    this.createSessionCalls.push({ workspaceId })
    return this.createSessionResult
  }

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
  streamEnded = false
  private frames: MuxFrame[] = []
  private waiters: Array<() => void> = []

  async describe(): Promise<Awaited<ReturnType<DshPort['describe']>>> {
    return { ok: true, value: { version: '1', cwd: '/', attachedSessions: 0, canOpenPath: false } as never }
  }

  async listWorkspaces(): Promise<Awaited<ReturnType<DshPort['listWorkspaces']>>> {
    return { ok: true, value: { items: this.workspaces as never, archivedSessionIds: [] } }
  }

  async listSessions(): Promise<Awaited<ReturnType<DshPort['listSessions']>>> {
    return { ok: true, value: { items: this.sessions as never } }
  }

  async loadHistory(sessionId: string): Promise<Awaited<ReturnType<DshPort['loadHistory']>>> {
    const events = this.historyEvents[String(sessionId)] ?? []
    return { ok: true, value: { events: events.map((event) => ({ event })), hasMore: false } }
  }

  async prompt(sessionId: string, text: string): Promise<Awaited<ReturnType<DshPort['prompt']>>> {
    this.promptCalls.push({ sessionId: String(sessionId), text, mode: 'queue' })
    return this.promptResult
  }

  async *stream(signal: AbortSignal, onOpen: () => void): AsyncIterable<MuxFrame> {
    onOpen()
    while (!this.streamEnded) {
      while (this.frames.length > 0) {
        const frame = this.frames.shift()
        if (frame !== undefined) yield frame
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        signal.addEventListener('abort', () => {
          this.streamEnded = true
          for (const waiter of this.waiters.splice(0)) waiter()
        }, { once: true })
      })
    }
  }

  push(frame: MuxFrame): void {
    this.frames.push(frame)
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

async function booted(port: FakePort): Promise<{ app: App; view: FakeView }> {
  const view = new FakeView()
  const app = new App(port, view, new AbortController().signal)
  const boot = await app.boot()
  assert.equal(boot.ok, true)
  return { app, view }
}

function userText(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  } as never
}

async function attach(app: App, port: FakePort): Promise<void> {
  port.historyEvents = { s1: [userText(1, 'first question')] }
  await app.attach('s1' as never)
}

test('one Enter submission produces one queue-mode prompt call for the session id', async () => {
  const port = new FakePort()
  const { app } = await booted(port)
  await attach(app, port)
  const result = await app.submit('hello there')
  assert.equal(result.ok, true)
  assert.equal(port.promptCalls.length, 1)
  assert.deepEqual(port.promptCalls[0], { sessionId: 's1', text: 'hello there', mode: 'queue' })
})

test('whitespace-only and slash-command input make no call', async () => {
  const port = new FakePort()
  const { app } = await booted(port)
  await attach(app, port)
  assert.deepEqual(await app.submit('   '), { ok: false, reason: 'blank' })
  assert.deepEqual(await app.submit('/model gpt4'), { ok: false, reason: 'slash-command' })
  assert.equal(port.promptCalls.length, 0)
})

test('concurrent submission is blocked while one is in flight', async () => {
  const port = new FakePort()
  const { app } = await booted(port)
  await attach(app, port)
  let release!: (value: Awaited<ReturnType<DshPort['prompt']>>) => void
  const original = port.prompt.bind(port)
  port.prompt = () => new Promise((resolve) => { release = resolve })
  const first = app.submit('one')
  const second = await app.submit('two')
  assert.deepEqual(second, { ok: false, reason: 'not-attached' })
  release({ ok: true, value: { accepted: true } })
  assert.equal((await first).ok, true)
  void original
})

test('acceptance shows Accepted by DSH and adds no transcript row', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  const before = view.renders.at(-1)
  const result = await app.submit('hello')
  assert.equal(result.ok, true)
  const after = view.renders.at(-1)
  assert.equal(after?.notice, 'Accepted by DSH')
  if (before?.attachment.phase === 'attached' && after?.attachment.phase === 'attached') {
    assert.equal(after.attachment.transcript.length, before.attachment.transcript.length)
  }
})

test('rejection preserves text and shows the safe error', async () => {
  const port = new FakePort()
  port.promptResult = { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  const { app, view } = await booted(port)
  await attach(app, port)
  const result = await app.submit('keep me')
  assert.deepEqual(result, { ok: false, reason: 'rejected', error: 'boom' })
  assert.equal(view.renders.at(-1)?.notice, 'boom')
})

test('a late response from an older session generation is dropped', async () => {
  const port = new FakePort()
  const { app } = await booted(port)
  await attach(app, port)
  let release!: (value: Awaited<ReturnType<DshPort['prompt']>>) => void
  port.prompt = () => new Promise((resolve) => { release = resolve })
  const pending = app.submit('old session text')
  await app.attach('s2' as never)
  release({ ok: true, value: { accepted: true } })
  const result = await pending
  assert.deepEqual(result, { ok: false, reason: 'stale' })
})

test('a pending question routes the composer to answering instead of prompting', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  // A question arrives on the mux.
  port.push({ type: 'question/requested', sessionId: 's1' as never, rpcId: 'rpc-q1', questions: [
    { id: 'qa', question: 'Approve?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ] } as never)
  await flush()
  // Enter answers the question and never calls session.prompt.
  const result = await app.submit('1')
  assert.deepEqual(result, { ok: true })
  assert.equal(port.promptCalls.length, 0)
  assert.equal(port.respondCalls.length, 1)
  const call = port.respondCalls[0]
  assert.equal(call?.rpcId, 'rpc-q1')
  const value = (call?.value as { ok: true; value: { answer: { answers: unknown[] } } }).value
  assert.deepEqual(value.answer.answers, [{ id: 'qa', selected: ['Yes'] }])
  // The pending question is dropped after the answer.
  const after = view.renders.at(-1)?.attachment
  assert.equal(after?.phase === 'attached' && after.pendingQuestions.length, 0)
})

test('editQueuedItem pops the last queued message back into the composer', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [
    { id: 'm1', placement: 'queued', message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'first prompt' }], source: { kind: 'user' } } },
    { id: 'm2', placement: 'queued', message: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'second prompt' }], source: { kind: 'user' } } },
  ] } as never)
  await flush()
  const text = await app.editQueuedItem()
  assert.equal(text, 'second prompt')
  assert.equal(port.updateQueueCalls.length, 1)
  const call = port.updateQueueCalls[0]
  assert.equal(call?.itemId, 'm2')
  assert.deepEqual(call?.action, { kind: 'remove' })
  // Nothing queued: no call, undefined.
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [] } as never)
  await flush()
  assert.equal(await app.editQueuedItem(), undefined)
  assert.equal(port.updateQueueCalls.length, 1)
  // A rejected removal surfaces the error and returns undefined.
  port.push({ type: 'session/queue', sessionId: 's1' as never, items: [
    { id: 'm3', placement: 'queued', message: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'stuck' }], source: { kind: 'user' } } },
  ] } as never)
  await flush()
  port.updateQueueResult = { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  assert.equal(await app.editQueuedItem(), undefined)
  assert.equal(view.renders.at(-1)?.notice, 'boom')
})

test('the Answered notice does not stick when the resolve frame beats the receipt', async () => {
  const port = new FakePort()
  port.historyEvents = { s1: [] }
  const { app, view } = await booted(port)
  await app.attach('s1' as never)
  port.push({ type: 'question/requested', sessionId: 's1' as never, rpcId: 'rpc-race', questions: [
    { id: 'qa', question: 'Approve?' },
  ] } as never)
  await flush()
  // Gate the respond so the host's resolve can arrive first.
  let releaseRespond: (() => void) | undefined
  const original = port.respond.bind(port)
  port.respond = async (message) => {
    await new Promise<void>((resolve) => { releaseRespond = resolve })
    return original(message)
  }
  const submitting = app.submit('yes')
  await flush()
  port.push({ type: 'question/resolved', sessionId: 's1' as never, questionRpcId: 'rpc-race', outcome: 'answered' } as never)
  await flush()
  releaseRespond?.()
  await submitting
  await flush()
  const last = view.renders.at(-1)
  assert.notEqual(last?.notice, 'Answered', 'no sticky notice when resolved arrived first')
})

test('parseQuestionAnswers: numbers, labels, and custom text', async () => {
  const questions = [
    { id: 'q1', question: 'Pick', options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] },
    { id: 'q2', question: 'Free form' },
  ]
  // A number selects by position.
  assert.deepEqual(parseQuestionAnswers(questions, '2'), [
    { id: 'q1', selected: ['beta'] },
    { id: 'q2', selected: [], custom: '2' },
  ])
  // An exact label match selects that option.
  assert.deepEqual(parseQuestionAnswers(questions, 'GAMMA'), [
    { id: 'q1', selected: ['gamma'] },
    { id: 'q2', selected: [], custom: 'GAMMA' },
  ])
  // Anything else is a custom answer.
  assert.deepEqual(parseQuestionAnswers(questions, 'do the other thing'), [
    { id: 'q1', selected: [], custom: 'do the other thing' },
    { id: 'q2', selected: [], custom: 'do the other thing' },
  ])
  // Out-of-range numbers fall back to a custom answer instead of silently
  // producing an empty selection.
  assert.deepEqual(parseQuestionAnswers(questions, '9'), [
    { id: 'q1', selected: [], custom: '9' },
    { id: 'q2', selected: [], custom: '9' },
  ])
  // Duplicates are deduped, and a single-select question takes the first
  // valid option only.
  const single = [{ id: 's', question: 'Pick one', options: [{ label: 'a' }, { label: 'b' }] }]
  assert.deepEqual(parseQuestionAnswers(single, '1,1'), [{ id: 's', selected: ['a'] }])
  assert.deepEqual(parseQuestionAnswers(single, '1,2'), [{ id: 's', selected: ['a'] }])
  // Multi-select questions keep every valid selection.
  const multi = [{ id: 'm', question: 'Pick any', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }]
  assert.deepEqual(parseQuestionAnswers(multi, '1,2'), [{ id: 'm', selected: ['a', 'b'] }])
  // A numeric option label matches the exact-label branch when the number is
  // out of range.
  const years = [{ id: 'y', question: 'Year?', options: [{ label: '2024' }, { label: '2025' }] }]
  assert.deepEqual(parseQuestionAnswers(years, '2024'), [{ id: 'y', selected: ['2024'] }])
  // Out-of-range numbers join the custom remainder instead of vanishing.
  assert.deepEqual(parseQuestionAnswers(multi, '1, 9, other'), [{ id: 'm', selected: ['a'], custom: 'other, 9' }])
  // Trailing commas and zero are tolerated (zero is out of range).
  assert.deepEqual(parseQuestionAnswers(single, '0,'), [{ id: 's', selected: [], custom: '0,' }])
  // Non-numeric parts dedupe like the numeric ones.
  assert.deepEqual(parseQuestionAnswers(multi, '1, x, x'), [{ id: 'm', selected: ['a'], custom: 'x' }])
  // Mixed input on a multi-select question keeps the custom text alongside
  // the selected options (the host schema allows selected + custom).
  const mixed = parseQuestionAnswers(multi, '1, other')
  assert.deepEqual(mixed, [{ id: 'm', selected: ['a'], custom: 'other' }])
  // Single-select questions keep the typed remainder alongside the option,
  // like the reference's panel (selected + custom).
  const singleMixed = parseQuestionAnswers(single, '1, other')
  assert.deepEqual(singleMixed, [{ id: 's', selected: ['a'], custom: 'other' }])
})

test('submission is disabled when disconnected', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  // Disconnect via a stream/error frame delivered while the stream is alive.
  port.push({ type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(view.renders.at(-1)?.connection, 'disconnected')
  const result = await app.submit('nope')
  assert.deepEqual(result, { ok: false, reason: 'not-attached' })
})

test('slash-command rejection surfaces the Web UI instruction', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  const result = await app.submit('/model gpt4')
  assert.deepEqual(result, { ok: false, reason: 'slash-command' })
  assert.equal(view.renders.at(-1)?.notice, 'Slash commands require the Web UI')
  assert.equal(port.promptCalls.length, 0)
})

test('the accepted notice clears when the prompt echo renders', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  await app.submit('hello')
  assert.equal(view.renders.at(-1)?.notice, 'Accepted by DSH')
  // The logged user/message echo streams back at the next sequence.
  port.push({ type: 'session/event', sessionId: 's1', event: userText(2, 'hello') } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(view.renders.at(-1)?.notice, undefined)
  const last = view.renders.at(-1)
  if (last?.attachment.phase === 'attached') {
    // history user + echo user, each with a trailing spacer.
    assert.equal(last.attachment.transcript.length, 4)
    assert.deepEqual(last.attachment.transcript[1], { kind: 'spacer' })
    assert.deepEqual(last.attachment.transcript[3], { kind: 'spacer' })
  }
})

test('the accepted notice is not cleared by a replacement user/message', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  await app.submit('hello')
  port.push({ type: 'session/event', sessionId: 's1', event: {
    ...userText(2, 'replacement'),
    surfaceOp: { op: 'replace', start: 0, end: 1 },
  } } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(view.renders.at(-1)?.notice, 'Accepted by DSH')
})

test('the accepted notice does not stick when the echo beats the response', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  let release!: (value: Awaited<ReturnType<DshPort['prompt']>>) => void
  port.prompt = () => new Promise((resolve) => { release = resolve })
  const pending = app.submit('hello')
  // The echo streams back while the unary is still in flight.
  port.push({ type: 'session/event', sessionId: 's1', event: userText(2, 'hello') } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  release({ ok: true, value: { accepted: true } })
  const result = await pending
  assert.deepEqual(result, { ok: true })
  // The echo already cleared the marker: no stuck accepted notice.
  assert.equal(view.renders.at(-1)?.notice, undefined)
})

test('a late echo cannot wipe a rejection error notice', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  let release!: (value: Awaited<ReturnType<DshPort['prompt']>>) => void
  port.prompt = () => new Promise((resolve) => { release = resolve })
  const pending = app.submit('hello')
  release({ ok: false, error: { code: 'internal', message: 'boom', details: {} } })
  assert.deepEqual(await pending, { ok: false, reason: 'rejected', error: 'boom' })
  assert.equal(view.renders.at(-1)?.notice, 'boom')
  // A late echo from the rejected attempt must not clear the error notice.
  port.push({ type: 'session/event', sessionId: 's1', event: userText(2, 'hello') } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(view.renders.at(-1)?.notice, 'boom')
})

test('a disconnect while a submission is in flight returns stale and keeps the notice', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  let release!: (value: Awaited<ReturnType<DshPort['prompt']>>) => void
  port.prompt = () => new Promise((resolve) => { release = resolve })
  const pending = app.submit('hello')
  port.push({ type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  release({ ok: true, value: { accepted: true } })
  const result = await pending
  assert.deepEqual(result, { ok: false, reason: 'stale' })
  const last = view.renders.at(-1)
  assert.equal(last?.connection, 'disconnected')
  assert.match(last?.notice ?? '', /Disconnected/)
  // The in-flight flag is cleared on the same-generation attachment.
  if (last?.attachment.phase === 'attached') {
    assert.equal(last.attachment.sending, false)
  }
})

test('a stale result cannot unwedge a newer attachment in flight', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  const held: Array<(value: Awaited<ReturnType<DshPort['prompt']>>) => void> = []
  port.prompt = () => new Promise((resolve) => { held.push(resolve) })
  const first = app.submit('on s1')
  await app.attach('s2' as never)
  const second = app.submit('on s2')
  // The first call resolves after the switch: its stale result must not
  // clear the newer attachment's in-flight flag.
  held[0]?.({ ok: true, value: { accepted: true } })
  assert.deepEqual(await first, { ok: false, reason: 'stale' })
  const during = view.renders.at(-1)
  if (during?.attachment.phase === 'attached') {
    assert.equal(during.attachment.sending, true, 'newer attachment must stay sending')
  }
  held[1]?.({ ok: true, value: { accepted: true } })
  assert.deepEqual(await second, { ok: true })
  assert.equal(view.renders.at(-1)?.attachment.phase, 'attached')
})

test('a late echo cannot wipe the slash-command instruction', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  let release!: (value: Awaited<ReturnType<DshPort['prompt']>>) => void
  port.prompt = () => new Promise((resolve) => { release = resolve })
  const pending = app.submit('hello')
  release({ ok: true, value: { accepted: true } })
  assert.deepEqual(await pending, { ok: true })
  assert.equal(view.renders.at(-1)?.notice, 'Accepted by DSH')
  // Slash input after acceptance, with the accepted prompt's echo still due.
  assert.deepEqual(await app.submit('/model'), { ok: false, reason: 'slash-command' })
  assert.equal(view.renders.at(-1)?.notice, 'Slash commands require the Web UI')
  port.push({ type: 'session/event', sessionId: 's1', event: userText(2, 'hello') } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(view.renders.at(-1)?.notice, 'Slash commands require the Web UI')
})

test('approval requests render, answer by echoing the rpcId, and settle', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  // The host asks for an approval with a stable rpcId.
  port.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'appr-1', toolName: 'bash', reason: 'run rm -rf', rpcId: 'rpc-appr-1' } as never)
  await flush()
  const pending = view.renders.at(-1)?.attachment
  assert.equal(pending?.phase === 'attached' ? pending.pendingApprovals.length : -1, 1)
  // Rejecting echoes the request's rpcId with the approval payload.
  await app.answerApproval('appr-1', 'rejected')
  assert.equal(port.respondCalls.length, 1)
  const call = port.respondCalls[0]
  assert.equal(call?.rpcId, 'rpc-appr-1')
  assert.deepEqual(call?.value, {
    ok: true,
    value: { sessionId: 's1', approvalId: 'appr-1', outcome: 'rejected' },
  })
  const settled = view.renders.at(-1)?.attachment
  assert.equal(settled?.phase === 'attached' ? settled.pendingApprovals.length : -1, 0)
  // Allowing the next approval sends 'allowed-once'.
  port.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'appr-2', toolName: 'bash', rpcId: 'rpc-appr-2' } as never)
  await flush()
  await app.answerApproval('appr-2', 'allowed-once')
  assert.equal(port.respondCalls[1]?.rpcId, 'rpc-appr-2')
  assert.deepEqual(port.respondCalls[1]?.value, {
    ok: true,
    value: { sessionId: 's1', approvalId: 'appr-2', outcome: 'allowed-once' },
  })
  // The host's approval/resolved settle clears a late/unknown entry too.
  port.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'appr-3', toolName: 'bash', rpcId: 'rpc-appr-3' } as never)
  await flush()
  port.push({ type: 'approval/resolved', sessionId: 's1', approvalId: 'appr-3', outcome: 'rejected' } as never)
  await flush()
  const settled2 = view.renders.at(-1)?.attachment
  assert.equal(settled2?.phase === 'attached' ? settled2.pendingApprovals.length : -1, 0)
  // Unknown approval ids are no-ops; a rejected response shows a notice.
  port.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'appr-4', toolName: 'bash', rpcId: 'rpc-appr-4' } as never)
  await flush()
  port.respondResult = { accepted: false, reason: 'not-pending' }
  await app.answerApproval('appr-4', 'allowed-once')
  assert.equal(view.renders.at(-1)?.notice, 'Approval already decided')
  // An unknown approval id is a silent no-op: no respond is issued.
  const callsBefore = port.respondCalls.length
  await app.answerApproval('nope', 'allowed-once')
  assert.equal(port.respondCalls.length, callsBefore)
})

test('pending approvals are deduped and capped at the oldest entries', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  for (let index = 0; index < 12; index += 1) {
    port.push({ type: 'approval/requested', sessionId: 's1', approvalId: `appr-${index}`, toolName: 'bash', rpcId: `rpc-${index}` } as never)
  }
  await flush()
  const pending = view.renders.at(-1)?.attachment
  assert.equal(pending?.phase === 'attached' ? pending.pendingApprovals.length : -1, 8)
  assert.equal(pending?.phase === 'attached' ? pending.pendingApprovals[0]?.approvalId : '', 'appr-0')
  // A duplicate id does not double the entry.
  port.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'appr-3', toolName: 'bash', rpcId: 'rpc-3' } as never)
  await flush()
  const after = view.renders.at(-1)?.attachment
  assert.equal(after?.phase === 'attached' ? after.pendingApprovals.length : -1, 8)
})

test('openModelPicker lists choices and applies the selection with effort', async () => {
  const port = new FakePort()
  port.listModelsResult = {
    ok: true,
    value: {
      current: { provider: 'p1', model: 'm1' },
      routable: true,
      groups: [
        {
          id: 'p1',
          name: 'Provider One',
          models: [
            { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
            { id: 'm2', name: 'Model Two' },
          ],
        },
      ],
      failures: [],
    },
  }
  const { app, view } = await booted(port)
  await attach(app, port)
  await app.openModelPicker()
  const pick = view.modelPicks.at(-1)
  assert.equal(pick?.choices.length, 2)
  assert.ok(pick?.choices[0]?.name.includes('(current)'), pick?.choices[0]?.name)
  // Choosing the effort-less model applies immediately without an effort.
  pick?.onSelect(pick.choices[1] as never)
  await flush()
  assert.deepEqual(port.selectModelCalls, [{ sessionId: 's1', selection: { provider: 'p1', model: 'm2' } }])
  // Choosing the effort model chains into an effort picker; picking High
  // sends the reasoning effort.
  port.selectModelCalls.length = 0
  await app.openModelPicker()
  const pick2 = view.modelPicks.at(-1)
  pick2?.onSelect(pick2.choices[0] as never)
  await flush()
  const effortPick = view.modelPicks.at(-1)
  assert.equal(effortPick?.choices.length, 3)
  assert.equal(effortPick?.choices[0]?.name, 'Default')
  effortPick?.onSelect(effortPick.choices[2] as never)
  await flush()
  assert.deepEqual(port.selectModelCalls, [{ sessionId: 's1', selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }])
  assert.ok(view.renders.at(-1)?.notice?.includes('Model: m1 (high)'), view.renders.at(-1)?.notice)
  // A list failure surfaces a notice.
  port.listModelsResult = { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  await app.openModelPicker()
  assert.equal(view.renders.at(-1)?.notice, 'boom')
})

test('steerQueuedItem steers the last queued message', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await attach(app, port)
  port.push({ type: 'session/queue', sessionId: 's1', items: [
    { id: 'm1', placement: 'queued', message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } } },
    { id: 'm2', placement: 'queued', message: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } } },
  ] } as never)
  await flush()
  assert.equal(await app.steerQueuedItem(), true)
  assert.equal(port.updateQueueCalls.length, 1)
  const call = port.updateQueueCalls[0]
  assert.equal(call?.itemId, 'm2')
  assert.deepEqual(call?.action, { kind: 'steer' })
  // Empty queue: no call.
  port.push({ type: 'session/queue', sessionId: 's1', items: [] } as never)
  await flush()
  assert.equal(await app.steerQueuedItem(), false)
  assert.equal(port.updateQueueCalls.length, 1)
  // Rejection surfaces the host's notice (e.g. steer-unavailable).
  port.push({ type: 'session/queue', sessionId: 's1', items: [
    { id: 'm3', placement: 'queued', message: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'c' }], source: { kind: 'user' } } },
  ] } as never)
  await flush()
  port.updateQueueResult = { ok: false, error: { code: 'steer-unavailable' as never, message: 'current turn no longer accepts steering', details: {} } }
  assert.equal(await app.steerQueuedItem(), false)
  assert.equal(view.renders.at(-1)?.notice, 'current turn no longer accepts steering')
})

test('attach and selectModel refresh the footer model label', async () => {
  const port = new FakePort()
  port.listModelsResult = {
    ok: true,
    value: {
      current: { provider: 'p1', model: 'm1' },
      routable: true,
      groups: [{
        id: 'p1',
        name: 'Provider One',
        models: [
          { id: 'm1', name: 'Model One' },
          { id: 'm2', name: 'Model Two', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        ],
      }],
      failures: [],
    },
  }
  const { app, view } = await booted(port)
  await attach(app, port)
  await flush()
  const attached = view.renders.at(-1)?.attachment
  assert.equal(attached?.phase === 'attached' ? attached.modelLabel : undefined, 'Provider One · Model One')
  // Selecting another model updates the label with the effort name.
  await app.openModelPicker()
  const pick = view.modelPicks.at(-1)
  pick?.onSelect(pick.choices[1] as never)
  await flush()
  const effortPick = view.modelPicks.at(-1)
  effortPick?.onSelect(effortPick.choices[2] as never)
  await flush()
  const after = view.renders.at(-1)?.attachment
  assert.equal(after?.phase === 'attached' ? after.modelLabel : undefined, 'Provider One · Model Two (High)')
  // A failed refresh leaves the previous label.
  port.listModelsResult = { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  await app.openModelPicker()
  assert.equal(view.renders.at(-1)?.notice, 'boom')
  const still = view.renders.at(-1)?.attachment
  assert.equal(still?.phase === 'attached' ? still.modelLabel : undefined, 'Provider One · Model Two (High)')
})

test('create project: picker row opens the path input, submit creates and opens the new project sessions', async () => {
  const port = new FakePort()
  const { app, view } = await booted(port)
  await app.openProjectPicker()
  assert.equal(view.projectPickerRows?.at(-1)?.key, CREATE_PROJECT)
  view.onProjectSelect?.(view.projectPickerRows?.at(-1) as never)
  assert.equal(view.createInputPicks.length, 1)
  // The path is trimmed before the write; success selects the new project
  // and opens its session picker (only the create row for an empty project).
  view.createInputPicks.at(-1)?.onSubmit('  /tmp/newproj  ')
  await flush()
  assert.deepEqual(port.createWorkspaceCalls, ['/tmp/newproj'])
  assert.equal(view.renders.at(-1)?.selectedProject, 'w-new')
  assert.deepEqual(view.sessionPickerRows?.map((row) => row.sessionId), [CREATE_SESSION])
})

test('create project: failure shows a notice and reopens the picker; ESC just reopens', async () => {
  const port = new FakePort()
  port.createWorkspaceResult = { ok: false, error: { code: 'workspace-invalid-path', message: 'no such directory', details: { path: '/nope' } } as never }
  const { app, view } = await booted(port)
  await app.openProjectPicker()
  view.onProjectSelect?.(view.projectPickerRows?.at(-1) as never)
  const input = view.createInputPicks.at(-1)
  input?.onSubmit('/nope')
  await flush()
  assert.equal(view.renders.at(-1)?.notice, 'Create project failed: no such directory')
  assert.ok(view.projectPickerRows !== undefined, 'project picker reopens')
  assert.equal(port.createWorkspaceCalls.length, 1, 'a write is never retried')
  // ESC from the path input returns to the refreshed project picker without
  // any write.
  view.onProjectSelect?.(view.projectPickerRows?.at(-1) as never)
  view.createInputPicks.at(-1)?.onCancel()
  await flush()
  assert.ok(view.projectPickerRows !== undefined)
  assert.equal(port.createWorkspaceCalls.length, 1)
})

test('create session: selects the project, writes workspaceId, and attaches to the fresh session', async () => {
  const port = new FakePort()
  port.workspaces = [{ workspaceId: 'w1', path: '/tmp/p', title: 'p', sessionIds: ['s1'], createdAt: '', updatedAt: '' }]
  port.sessions = [{ sessionId: 's1' }]
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'w1' as never, title: 'p' })
  const createRow = view.sessionPickerRows?.at(-1)
  assert.equal(createRow?.sessionId, CREATE_SESSION)
  view.onSessionSelect?.(createRow as never)
  await flush()
  assert.deepEqual(port.createSessionCalls, [{ workspaceId: 'w1' }])
  const attached = view.renders.at(-1)?.attachment
  assert.equal(attached?.phase, 'attached')
  assert.equal(attached?.sessionId, 's-new')
})

test('create session: All sessions omits the workspace; a failure reopens the picker with a notice', async () => {
  const port = new FakePort()
  port.workspaces = [{ workspaceId: 'w1', path: '/tmp/p', title: 'p', sessionIds: ['s1'], createdAt: '', updatedAt: '' }]
  port.sessions = [{ sessionId: 's1' }]
  const { app, view } = await booted(port)
  await app.selectProject({ key: 'all', title: 'All sessions' })
  view.onSessionSelect?.(view.sessionPickerRows?.at(-1) as never)
  await flush()
  assert.deepEqual(port.createSessionCalls, [{ workspaceId: undefined }])
  assert.equal(view.renders.at(-1)?.attachment.phase, 'attached')
  // A rejected create reopens the session picker and never retries.
  port.createSessionResult = { ok: false, error: { code: 'session-conflict', message: 'conflict', details: { sessionId: 's2', requestedCwd: '/tmp' } } as never }
  view.closePicker()
  await app.openSessionPicker()
  view.onSessionSelect?.(view.sessionPickerRows?.at(-1) as never)
  await flush()
  assert.equal(view.renders.at(-1)?.notice, 'Create session failed: conflict')
  assert.ok(view.sessionPickerRows !== undefined, 'session picker reopens')
  assert.equal(port.createSessionCalls.length, 2)
})
