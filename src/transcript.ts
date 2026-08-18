/**
 * Pure SessionEvent-to-transcript projection.
 *
 * History and live events fold through the same projector: every event
 * advances the sequence watermark, but only append-origin user/assistant
 * messages may create finalized rows, and assistant chunks accumulate visible
 * text per block index so an unfinished response renders as a partial.
 * Reasoning, usage, and tool-argument deltas are deliberately not displayed;
 * unknown events and block kinds advance the watermark without rendering.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

/** One visible piece of assistant output: text, a compact tool marker, or an image. */
export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'image' }

/** A finalized transcript row. */
export type TranscriptRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; segments: readonly AssistantSegment[] }

/** Per-block-index accumulator inside a partial. */
export interface PartialBlock {
  type: string | undefined
  text: string
  final: AssistantSegment | undefined
}

/**
 * In-flight assistant output for one turn/step. Keeps the raw per-block
 * accumulators so live chunk deltas keep appending across renders; the visible
 * segments are derived with {@link partialSegments}.
 */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: ReadonlyMap<number, PartialBlock>
}

/** Projector output: finalized rows, the in-flight partial, and the watermark. */
export interface TranscriptState {
  rows: readonly TranscriptRow[]
  partial: PartialAssistant | undefined
  lastSeq: number
}

export function emptyTranscript(): TranscriptState {
  return { rows: [], partial: undefined, lastSeq: -1 }
}

/** Visible segments of a partial in block-index order. */
export function partialSegments(partial: PartialAssistant): readonly AssistantSegment[] {
  const segments: AssistantSegment[] = []
  for (const index of [...partial.blocks.keys()].sort((a, b) => a - b)) {
    const block = partial.blocks.get(index)
    if (block === undefined) continue
    if (block.final !== undefined) {
      segments.push(block.final)
    } else if (block.type === 'text') {
      segments.push({ kind: 'text', text: block.text })
    }
  }
  return segments
}

/** Fold one event into the transcript state. Pure: never mutates its inputs. */
export function applyEvent(state: TranscriptState, event: SessionEvent): TranscriptState {
  const lastSeq = Math.max(state.lastSeq, event.seq)
  const base: TranscriptState = { ...state, lastSeq }

  if (event.type === 'user/message') {
    if (event.surfaceOp !== 'append' || event.data.source.kind !== 'user') return base
    const text = event.data.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    return { ...base, rows: [...state.rows, { kind: 'user', text }] }
  }

  if (event.type === 'assistant/chunk') {
    return applyChunk(base, event.data.turn, event.data.step, event.data.chunk)
  }

  if (event.type === 'assistant/message') {
    if (event.surfaceOp !== 'append') return base
    const segments = segmentsFromBlocks(event.data.message.content)
    const { turn, step } = event.data
    const partial = state.partial !== undefined && state.partial.turn === turn && state.partial.step === step
      ? undefined
      : state.partial
    return {
      ...base,
      partial,
      rows: [...state.rows, { kind: 'assistant', segments }],
    }
  }

  // llm/retry is a plugin-merged event type not present in the published
  // SessionEvent union; match it structurally so abandoned partial text does
  // not remain beside the retry.
  if ((event as { type: string }).type === 'llm/retry') {
    const data = (event as unknown as { data?: { turn?: number; step?: number } }).data
    if (data !== undefined
      && state.partial !== undefined
      && data.turn === state.partial.turn
      && data.step === state.partial.step) {
      return { ...base, partial: undefined }
    }
    return base
  }

  return base
}

/** Fold a whole batch (history page or buffer) through the same projector. */
export function projectEvents(events: readonly SessionEvent[]): TranscriptState {
  let state = emptyTranscript()
  for (const event of events) {
    state = applyEvent(state, event)
  }
  return state
}

function applyChunk(state: TranscriptState, turn: number, step: number, chunk: StreamChunk): TranscriptState {
  const current = state.partial
  const blocks = current !== undefined && current.turn === turn && current.step === step
    ? new Map(current.blocks)
    : new Map<number, PartialBlock>()
  const next = updateBlocks(blocks, chunk)
  return { ...state, partial: { turn, step, blocks: next } }
}

function updateBlocks(blocks: Map<number, PartialBlock>, chunk: StreamChunk): ReadonlyMap<number, PartialBlock> {
  if (chunk.type === 'block-start') {
    blocks.set(chunk.index, { type: chunk.blockType, text: '', final: undefined })
  } else if (chunk.type === 'text-delta') {
    const current = blocks.get(chunk.index)
    if (current === undefined || current.final !== undefined) return blocks
    blocks.set(chunk.index, { ...current, text: current.text + chunk.text })
  } else if (chunk.type === 'block-end') {
    const block = chunk.block
    const current = blocks.get(chunk.index) ?? { type: block.type, text: '', final: undefined }
    blocks.set(chunk.index, {
      type: current.type ?? block.type,
      text: current.text,
      final: segmentFromBlock(block.type, block),
    })
  }
  // reasoning-delta, tool-call-delta, usage, finish: deliberately not displayed.
  return blocks
}

function segmentFromBlock(type: string, block: unknown): AssistantSegment | undefined {
  if (type === 'text') {
    const text = (block as { text?: string }).text
    return text === undefined ? undefined : { kind: 'text', text }
  }
  if (type === 'tool-call') {
    const name = (block as { name?: string }).name
    return name === undefined ? undefined : { kind: 'tool', name }
  }
  if (type === 'image') return { kind: 'image' }
  return undefined
}

/** Finalized segments from an assembled assistant message's content blocks. */
function segmentsFromBlocks(content: readonly unknown[]): readonly AssistantSegment[] {
  const segments: AssistantSegment[] = []
  for (const block of content) {
    const type = (block as { type?: string }).type
    if (type === undefined) continue
    const segment = segmentFromBlock(type, block)
    if (segment !== undefined) segments.push(segment)
  }
  return segments
}
