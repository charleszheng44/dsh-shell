/**
 * transcript.ts pure projector tests: append-versus-replacement surface
 * events, block-indexed chunk accumulation, retry clearing, finalized
 * replacement without duplication, unknown-event watermark advancement, and
 * user-source filtering.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

import { applyEvent, emptyTranscript, partialSegments, projectEvents, type TranscriptState } from '../src/transcript.js'

function userMessage(seq: number, opts: {
  sourceKind?: string
  surfaceOp?: unknown
  text?: string
} = {}): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    surfaceOp: opts.surfaceOp ?? 'append',
    data: {
      id: `msg-${seq}`,
      role: 'user',
      content: [{ type: 'text', text: opts.text ?? 'hello' }],
      source: { kind: opts.sourceKind ?? 'user' },
    },
  } as unknown as SessionEvent
}

function assistantMessage(seq: number, turn: number, step: number, content: unknown[], opts: {
  surfaceOp?: unknown
} = {}): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    surfaceOp: opts.surfaceOp ?? 'append',
    data: {
      turn,
      step,
      message: { id: `msg-${seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'p' } },
    },
  } as unknown as SessionEvent
}

function chunk(seq: number, turn: number, step: number, chunkPayload: unknown): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 0,
    data: { turn, step, chunk: chunkPayload },
  } as unknown as SessionEvent
}

function unknownEvent(seq: number, type = 'tool/call'): SessionEvent {
  return { type, seq, time: 0, data: {} } as unknown as SessionEvent
}

function retry(seq: number, turn: number, step: number): SessionEvent {
  return { type: 'llm/retry', seq, time: 0, data: { turn, step } } as unknown as SessionEvent
}

test('append-origin user and assistant messages create finalized rows', () => {
  const state = projectEvents([
    userMessage(1, { text: 'hi' }),
    assistantMessage(2, 0, 0, [{ type: 'text', text: 'yo' }]),
  ])
  assert.equal(state.rows.length, 2)
  assert.deepEqual(state.rows[0], { kind: 'user', text: 'hi' })
  assert.deepEqual(state.rows[1], { kind: 'assistant', segments: [{ kind: 'text', text: 'yo' }] })
  assert.equal(state.lastSeq, 2)
  assert.equal(state.partial, undefined)
})

test('replacement surface events never render', () => {
  const state = projectEvents([
    userMessage(1, { text: 'v1', surfaceOp: { op: 'replace', start: 0, end: 1 } }),
    assistantMessage(2, 0, 0, [{ type: 'text', text: 'v1' }], {
      surfaceOp: { op: 'replace', start: 0, end: 1 },
    }),
  ])
  assert.equal(state.rows.length, 0)
  assert.equal(state.lastSeq, 2)
})

test('user/message renders only when source.kind is user', () => {
  const injected = projectEvents([userMessage(1, { sourceKind: 'plugin', text: 'context' })])
  assert.equal(injected.rows.length, 0)
  const direct = projectEvents([userMessage(1, { sourceKind: 'user', text: 'real' })])
  assert.equal(direct.rows.length, 1)
})

test('unknown events advance the watermark without rendering', () => {
  const state = projectEvents([unknownEvent(1), unknownEvent(2, 'step/start'), userMessage(3)])
  assert.equal(state.rows.length, 1)
  assert.equal(state.lastSeq, 3)
})

test('chunk text-deltas accumulate into a partial by block index', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'Hello ' }),
    chunk(3, 0, 0, { type: 'text-delta', index: 0, text: 'world' }),
  ])
  assert.equal(state.rows.length, 0)
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'Hello world' }])
  assert.equal(state.lastSeq, 3)
})

test('block-end finalizes text and tool-call markers, images render [image]', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'done' }),
    chunk(3, 0, 0, { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }),
    chunk(4, 0, 0, { type: 'block-start', index: 1, blockType: 'tool-call' }),
    chunk(5, 0, 0, { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' } }),
    chunk(6, 0, 0, { type: 'block-start', index: 2, blockType: 'image' }),
    chunk(7, 0, 0, { type: 'block-end', index: 2, block: { type: 'image', data: 'x', mediaType: 'image/png' } }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [
    { kind: 'text', text: 'done' },
    { kind: 'tool', name: 'bash' },
    { kind: 'image' },
  ])
})

test('reasoning deltas and usage chunks are not displayed', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'reasoning' }),
    chunk(2, 0, 0, { type: 'reasoning-delta', index: 0, text: 'think think' }),
    chunk(3, 0, 0, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think think' } }),
    chunk(4, 0, 0, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }),
    chunk(5, 0, 0, { type: 'block-start', index: 1, blockType: 'text' }),
    chunk(6, 0, 0, { type: 'text-delta', index: 1, text: 'visible' }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'visible' }])
  assert.equal(state.lastSeq, 6)
})

test('a finalized assistant message replaces the matching partial without duplication', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'partial ' }),
    assistantMessage(3, 0, 0, [
      { type: 'text', text: 'final answer' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ]),
  ])
  assert.equal(state.rows.length, 2)
  assert.equal(state.partial, undefined)
  assert.deepEqual(state.rows[0], {
    kind: 'assistant',
    segments: [{ kind: 'text', text: 'final answer' }],
  })
  assert.deepEqual(state.rows[1], { kind: 'toolCall', name: 'bash' })
})

test('llm/retry clears the failed turn/step partial', () => {
  const state = projectEvents([
    chunk(1, 1, 2, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 1, 2, { type: 'text-delta', index: 0, text: 'abandoned' }),
    retry(3, 1, 2),
  ])
  assert.equal(state.partial, undefined)
  assert.equal(state.lastSeq, 3)
})

test('llm/retry for a different turn/step leaves the partial intact', () => {
  const state = projectEvents([
    chunk(1, 1, 2, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 1, 2, { type: 'text-delta', index: 0, text: 'kept' }),
    retry(3, 9, 9),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'kept' }])
})

test('chunks for a new turn/step start a fresh partial', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'old' }),
    chunk(3, 1, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(4, 1, 0, { type: 'text-delta', index: 0, text: 'new' }),
  ])
  assert.equal(state.partial?.turn, 1)
  assert.equal(state.partial?.step, 0)
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'new' }])
})

test('in-flight history partial reconstruction keeps the unfinished prefix', () => {
  const state = projectEvents([
    userMessage(1, { text: 'question' }),
    chunk(2, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(3, 0, 0, { type: 'text-delta', index: 0, text: 'prefix of an unfinished response' }),
  ])
  assert.equal(state.rows.length, 1)
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'prefix of an unfinished response' }])
})

test('applyEvent is pure: the input state is never mutated', () => {
  const before = emptyTranscript()
  const after = applyEvent(before, userMessage(1, { text: 'hi' }))
  assert.equal(before.rows.length, 0)
  assert.equal(after.rows.length, 1)
  assert.notEqual(before, after)
})

test('segments keep block order when blocks interleave', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'tool-call' }),
    chunk(2, 0, 0, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' } }),
    chunk(3, 0, 0, { type: 'block-start', index: 1, blockType: 'text' }),
    chunk(4, 0, 0, { type: 'text-delta', index: 1, text: 'after tool' }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [
    { kind: 'tool', name: 'bash' },
    { kind: 'text', text: 'after tool' },
  ])
})

test('turn/end clears a partial that never finalized (error/aborted turn)', () => {
  const state = projectEvents([
    userMessage(1, { text: 'q1' }),
    chunk(2, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(3, 0, 0, { type: 'text-delta', index: 0, text: 'abandoned prefix' }),
    { type: 'turn/end', seq: 4, time: 0, data: { turn: 0, reason: { kind: 'error' } } } as never,
    userMessage(5, { text: 'q2' }),
    assistantMessage(6, 1, 0, [{ type: 'text', text: 'final answer' }]),
  ])
  assert.equal(state.partial, undefined)
  assert.deepEqual(state.rows.map((row) => row.kind), ['user', 'user', 'assistant'])
})

test('turn/end for a different turn leaves the partial intact', () => {
  const state = projectEvents([
    chunk(1, 1, 2, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 1, 2, { type: 'text-delta', index: 0, text: 'kept' }),
    { type: 'turn/end', seq: 3, time: 0, data: { turn: 9, reason: { kind: 'stop' } } } as never,
  ])
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'kept' }])
})

test('an empty or image-only user message renders no row', () => {
  const empty = projectEvents([userMessage(1, { text: '' })])
  assert.equal(empty.rows.length, 0)
  const imageOnly = projectEvents([{
    type: 'user/message',
    seq: 1,
    time: 0,
    surfaceOp: 'append',
    data: {
      id: 'm1',
      role: 'user',
      content: [{ type: 'image', data: 'x', mediaType: 'image/png' }],
      source: { kind: 'user' },
    },
  } as unknown as SessionEvent])
  assert.equal(imageOnly.rows.length, 0)
})

test('a text-delta before its block-start still accumulates', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'text-delta', index: 0, text: 'early ' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'delta' }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'early delta' }])
})

test('block-start after lazy text-deltas keeps the accumulated text', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'text-delta', index: 0, text: 'early ' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'delta' }),
    chunk(3, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(4, 0, 0, { type: 'text-delta', index: 0, text: ' late' }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: 'early delta late' }])
})

test('an empty-content assistant/message finalizes the partial but renders no row', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'text-delta', index: 0, text: 'partial' }),
    assistantMessage(3, 0, 0, []),
  ])
  assert.equal(state.partial, undefined)
  assert.equal(state.rows.length, 0)
})

test('a whitespace-only user message renders no row', () => {
  const state = projectEvents([userMessage(1, { text: '   ' })])
  assert.equal(state.rows.length, 0)
})

test('an empty text block-end produces no segment', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'block-end', index: 0, block: { type: 'text', text: '' } }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [])
})

test('a whitespace-only text block-end produces no segment', () => {
  const state = projectEvents([
    chunk(1, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(2, 0, 0, { type: 'block-end', index: 0, block: { type: 'text', text: ' \n  ' } }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [])
})

test('an unterminated code fence stays visible in the partial', () => {
  const state = projectEvents([
    userMessage(1, { text: 'show me' }),
    chunk(2, 0, 0, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(3, 0, 0, { type: 'text-delta', index: 0, text: '```ts\nconst x = 1\n' }),
  ])
  assert.deepEqual(partialSegments(state.partial as never), [{ kind: 'text', text: '```ts\nconst x = 1\n' }])
})

function toolResultEvent(seq: number, callId: string, text: string, opts: { turn?: number; step?: number } = {}): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      turn: opts.turn ?? 1,
      step: opts.step ?? 1,
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text }],
        }],
      },
    },
  } as unknown as SessionEvent
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return { type: 'turn/end', seq, time: 0, data: { turn } } as unknown as SessionEvent
}

test('tool-call segments carry their compacted arguments', () => {
  const state = projectEvents([
    assistantMessage(1, 1, 1, [{
      type: 'tool-call',
      id: 'call-1',
      name: 'bash',
      arguments: '{"command": "  ls   -la  ", "description": "List files"}',
    }]),
  ])
  assert.deepEqual(state.rows, [{
    kind: 'toolCall',
    name: 'bash',
    args: '{"command": " ls -la ", "description": "List files"}',
  }])
  // A tool-call with an empty argument object carries no args.
  const empty = projectEvents([
    assistantMessage(1, 1, 1, [{ type: 'tool-call', id: 'call-2', name: 'bash', arguments: '{}' }]),
  ])
  assert.deepEqual(empty.rows, [{ kind: 'toolCall', name: 'bash' }])
})

test('a tool/result appends a named, bounded output row', () => {
  const state = projectEvents([
    assistantMessage(1, 1, 1, [{ type: 'tool-call', id: 'call-1', name: 'run_code', arguments: '{"code":"x"}' }]),
    toolResultEvent(2, 'call-1', 'line one\nline two\nline three'),
  ])
  assert.deepEqual(state.rows, [
    { kind: 'toolCall', name: 'run_code', args: '{"code":"x"}' },
    { kind: 'toolResult', name: 'run_code', output: 'line one\nline two\nline three' },
  ])
})

test('a tool/result for an unknown call is not rendered', () => {
  const state = projectEvents([
    toolResultEvent(1, 'call-unknown', 'output'),
  ])
  assert.deepEqual(state.rows, [])
})

test('turn/end clears pending tool names so a late result is dropped', () => {
  const state = projectEvents([
    assistantMessage(1, 1, 1, [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' }]),
    turnEnd(2, 1),
    toolResultEvent(3, 'call-1', 'late output'),
  ])
  assert.deepEqual(state.rows, [
    { kind: 'toolCall', name: 'bash', args: '{"cmd":"ls"}' },
  ])
})

test('tool output is truncated to a bounded number of lines', () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const state = projectEvents([
    assistantMessage(1, 1, 1, [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }]),
    toolResultEvent(2, 'call-1', manyLines),
  ])
  const row = state.rows.find((r) => r.kind === 'toolResult')
  assert.equal(row?.kind, 'toolResult')
  if (row?.kind === 'toolResult') {
    const lines = row.output.split('\n')
    assert.ok(lines.length <= 25)
    assert.match(row.output, /output truncated/)
  }
})
