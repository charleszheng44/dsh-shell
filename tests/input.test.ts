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

import { App, parseQuestionAnswers, type AppState, type AppView } from '../src/app.js'
import type { DshPort } from '../src/dsh.js'

class FakeView implements AppView {
  renders: AppState[] = []
  render(state: AppState): void { this.renders.push(state) }
  openProjectPicker(): void {}
  openSessionPicker(): void {}
  closePicker(): void {}
  stop(): void {}
}

class FakePort implements DshPort {
  workspaces = []
  sessions = []
  historyEvents: Record<string, SessionEvent[]> = {}
  promptCalls: Array<{ sessionId: string; text: string; mode: string }> = []
  promptResult: Awaited<ReturnType<DshPort['prompt']>> = { ok: true, value: { accepted: true } }

  respondCalls: Array<{ rpcId: string; value: unknown }> = []
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
    return { ok: true, value: { items: [], archivedSessionIds: [] } }
  }

  async listSessions(): Promise<Awaited<ReturnType<DshPort['listSessions']>>> {
    return { ok: true, value: { items: [] } }
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
    assert.equal(last.attachment.transcript.length, 2)
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
