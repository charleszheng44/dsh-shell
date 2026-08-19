/**
 * Pure SessionEvent-to-transcript projection.
 *
 * History and live events fold through the same projector: every event
 * advances the sequence watermark, but only append-origin user/assistant
 * messages may create finalized rows, and assistant chunks accumulate visible
 * text per block index so an unfinished response renders as a partial.
 * The thinking chain (reasoning-delta chunks / reasoning blocks) renders as
 * its own bounded row; usage and tool-argument deltas are deliberately not
 * displayed; unknown events and block kinds advance the watermark without
 * rendering.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

/** One visible piece of assistant output: text, the thinking chain, a tool
 *  call with its input, or an image. */
export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; truncated: boolean }
  | { kind: 'tool'; name: string; args?: string }
  | { kind: 'image' }

/** A finalized transcript row. */
export type TranscriptRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; segments: readonly AssistantSegment[] }
  | { kind: 'reasoning'; text: string; truncated: boolean }
  | { kind: 'toolCall'; name: string; args?: string }
  | { kind: 'toolResult'; name: string; output: string; truncated: boolean; error: boolean }
  /** One blank row between transcript sections (thinking, text, tools). */
  | { kind: 'spacer' }

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
  /** Tool-call ids seen in finalized assistant messages, mapped to their
   *  names so a later tool/result can name its output row. Cleared at
   *  turn/end once every result of the turn has arrived. */
  pendingTools: Readonly<Record<string, string>>
  /** The open turn's number (turn/start seen, no matching turn/end yet): the
   *  view shows the Deep diving status while the session is working. */
  turnActive: number | undefined
}

export function emptyTranscript(): TranscriptState {
  return { rows: [], partial: undefined, lastSeq: -1, pendingTools: {}, turnActive: undefined }
}

/** Visible segments of a partial in block-index order. */
export function partialSegments(partial: PartialAssistant): readonly AssistantSegment[] {
  const segments: AssistantSegment[] = []
  for (const index of [...partial.blocks.keys()].sort((a, b) => a - b)) {
    const block = partial.blocks.get(index)
    if (block === undefined) continue
    if (block.final !== undefined) {
      segments.push(block.final)
    } else if (block.type === 'reasoning' && block.text !== '') {
      const bounded = truncateReasoning(block.text)
      segments.push({ kind: 'reasoning', text: bounded.text, truncated: bounded.truncated })
    } else if (block.type === 'text' && block.text !== '') {
      segments.push({ kind: 'text', text: block.text })
    } else if (block.type === undefined && block.text !== '') {
      // text-delta chunks only ever carry visible text; a delta that arrived
      // before its block-start is therefore text even without a type yet.
      segments.push({ kind: 'text', text: block.text })
    }
  }
  return segments
}

/** Upper bound on one block's accumulated visible text (UTF-16 units). */
const MAX_BLOCK_TEXT_BYTES = 1_000_000

/** Upper bound on one displayed tool input (UTF-16 units). */
const TOOL_ARGS_MAX = 140

/** Upper bound on one displayed tool output: lines and characters. */
const TOOL_OUTPUT_MAX_LINES = 24
const TOOL_OUTPUT_MAX_CHARS = 4000

/** Compact one-line tool input: whitespace collapsed, truncated. */
function compactToolArgs(args: string): string {
  const oneLine = args.replace(/\s+/g, ' ').trim()
  return oneLine.length > TOOL_ARGS_MAX ? `${oneLine.slice(0, TOOL_ARGS_MAX)}…` : oneLine
}

/** Bounds for one displayed thinking chain: the reasoning of one step is
 *  usually long, and the transcript must not balloon. */
const REASONING_MAX_LINES = 8
const REASONING_MAX_CHARS = 2000

/** Bound a thinking chain like tool output: characters first, then lines,
 *  with the `truncated` flag travelling with the segment/row. */
function truncateReasoning(text: string): { text: string; truncated: boolean } {
  if (text.length > REASONING_MAX_CHARS) {
    return {
      text: `${text.slice(0, REASONING_MAX_CHARS)}… (thinking truncated)`,
      truncated: true,
    }
  }
  const lines = text.split('\n')
  if (lines.length > REASONING_MAX_LINES) {
    return {
      text: `${lines.slice(0, REASONING_MAX_LINES).join('\n')}\n… (thinking truncated)`,
      truncated: true,
    }
  }
  return { text, truncated: false }
}

/** Bound a tool output so a verbose result cannot dominate the transcript.
 *  The `truncated` flag travels with the row so the view never has to sniff
 *  the marker string out of the content. */
function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length > TOOL_OUTPUT_MAX_CHARS) {
    return {
      text: `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}… (output truncated)`,
      truncated: true,
    }
  }
  const lines = text.split('\n')
  if (lines.length > TOOL_OUTPUT_MAX_LINES) {
    return {
      text: `${lines.slice(0, TOOL_OUTPUT_MAX_LINES).join('\n')}\n… (output truncated)`,
      truncated: true,
    }
  }
  return { text, truncated: false }
}

/** Split a message's segments into text rows and standalone tool-call rows,
 *  matching how pi and the Web UI render each tool call as its own block
 *  between the surrounding text. */
function rowsFromSegments(segments: readonly AssistantSegment[]): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let textRun: AssistantSegment[] = []
  const pushTextRun = (): void => {
    if (textRun.length === 0) return
    rows.push({ kind: 'assistant', segments: textRun }, { kind: 'spacer' })
    textRun = []
  }
  for (const segment of segments) {
    if (segment.kind === 'reasoning') {
      pushTextRun()
      // A thinking block is its own section; the spacer after it separates
      // it from what follows.
      rows.push({ kind: 'reasoning', text: segment.text, truncated: segment.truncated }, { kind: 'spacer' })
    } else if (segment.kind === 'tool') {
      pushTextRun()
      // The call and its result stay attached (one unit); the result's own
      // spacer separates the unit from the next section.
      rows.push(segment.args === undefined
        ? { kind: 'toolCall', name: segment.name }
        : { kind: 'toolCall', name: segment.name, args: segment.args })
    } else {
      textRun.push(segment)
    }
  }
  pushTextRun()
  return rows
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
    // An image-only, empty, or whitespace-only user message renders nothing.
    if (text.trim() === '') return base
    return { ...base, rows: [...state.rows, { kind: 'user', text }, { kind: 'spacer' }] }
  }

  if (event.type === 'assistant/chunk') {
    return applyChunk(base, event.data.turn, event.data.step, event.data.chunk)
  }

  if (event.type === 'turn/start') {
    // A turn opened: the view shows the Deep diving status until its end.
    return { ...base, turnActive: event.data.turn }
  }

  if (event.type === 'turn/end') {
    // A turn that ended without a finalized assistant/message (error, abort,
    // or empty turn) must not leave abandoned partial text beside later rows.
    // Every tool result of the turn has arrived by now, so the id map clears.
    const turnActive = state.turnActive === event.data.turn ? undefined : state.turnActive
    if (state.partial !== undefined && state.partial.turn === event.data.turn) {
      return { ...base, partial: undefined, pendingTools: {}, turnActive }
    }
    return { ...base, pendingTools: {}, turnActive }
  }

  if (event.type === 'assistant/message') {
    if (event.surfaceOp !== 'append') return base
    const segments = segmentsFromBlocks(event.data.message.content)
    const { turn, step } = event.data
    const partial = state.partial !== undefined && state.partial.turn === turn && state.partial.step === step
      ? undefined
      : state.partial
    // Remember the turn's tool-call ids so a later tool/result can name its
    // output row; the map is cleared at turn/end.
    const pendingTools = { ...state.pendingTools }
    for (const block of event.data.message.content) {
      const tool = block as { type?: string; id?: unknown; name?: string }
      if (tool.type === 'tool-call' && typeof tool.id === 'string' && typeof tool.name === 'string') {
        pendingTools[tool.id] = tool.name
      }
    }
    // An empty-content assistant message exists only to carry usage; it
    // finalizes the partial but renders no row.
    if (segments.length === 0) return { ...base, partial, pendingTools }
    return {
      ...base,
      partial,
      pendingTools,
      rows: [...state.rows, ...rowsFromSegments(segments)],
    }
  }

  if (event.type === 'tool/result') {
    // The result of a tool call arrives as its own event; render it as a
    // bounded output row named after the call, matching how the Web UI shows
    // tool outcomes below the call. A failed call carries isError on the
    // tool-result part and renders with the error tint.
    const message = event.data?.message as
      | { source?: { callId?: unknown }; content?: readonly { content?: readonly { type?: string; text?: string }[]; isError?: unknown }[] }
      | undefined
    const callId = typeof message?.source?.callId === 'string' ? message.source.callId : undefined
    const text = (message?.content ?? [])
      .flatMap((part) => part.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n')
    const error = (message?.content ?? []).some((part) => part.isError === true)
    const name = callId === undefined ? undefined : state.pendingTools[callId]
    if (callId === undefined || name === undefined || text === '') return base
    const bounded = truncateOutput(text)
    return {
      ...base,
      rows: [...state.rows, { kind: 'toolResult', name, output: bounded.text, truncated: bounded.truncated, error }, { kind: 'spacer' }],
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
    // Keep any text a lazy text-delta accumulated before this start.
    const current = blocks.get(chunk.index)
    blocks.set(chunk.index, { type: chunk.blockType, text: current?.text ?? '', final: undefined })
  } else if (chunk.type === 'text-delta') {
    // Lazily create the accumulator if a delta arrives before its block-start
    // (robust against reordered live chunks in PR 3).
    const current = blocks.get(chunk.index) ?? { type: undefined, text: '', final: undefined }
    if (current.final !== undefined) return blocks
    const text = current.text + chunk.text
    // A hostile host must not be able to grow one block's accumulator without
    // bound; past the cap the block is dropped (the stream gap rules then
    // disconnect the client).
    if (text.length > MAX_BLOCK_TEXT_BYTES) return blocks
    blocks.set(chunk.index, { ...current, text })
  } else if (chunk.type === 'reasoning-delta') {
    // The thinking chain accumulates like text, in its own block.
    const current = blocks.get(chunk.index) ?? { type: 'reasoning', text: '', final: undefined }
    if (current.final !== undefined) return blocks
    const text = current.text + chunk.text
    if (text.length > MAX_BLOCK_TEXT_BYTES) return blocks
    blocks.set(chunk.index, { ...current, text })
  } else if (chunk.type === 'block-end') {
    const block = chunk.block
    const current = blocks.get(chunk.index) ?? { type: block.type, text: '', final: undefined }
    blocks.set(chunk.index, {
      type: current.type ?? block.type,
      text: current.text,
      final: segmentFromBlock(block.type, block),
    })
  }
  // tool-call-delta, usage, finish: deliberately not displayed.
  return blocks
}

function segmentFromBlock(type: string, block: unknown): AssistantSegment | undefined {
  if (type === 'text') {
    const text = (block as { text?: string }).text
    return text === undefined || text.trim() === '' ? undefined : { kind: 'text', text }
  }
  if (type === 'tool-call') {
    const tool = block as { name?: string; arguments?: unknown }
    const name = tool.name
    if (name === undefined) return undefined
    const compact = typeof tool.arguments === 'string' ? compactToolArgs(tool.arguments) : undefined
    // An empty argument object is display noise; skip it.
    const args = compact !== undefined && compact !== '' && compact !== '{}' && compact !== '[]' ? compact : undefined
    return args === undefined ? { kind: 'tool', name } : { kind: 'tool', name, args }
  }
  if (type === 'reasoning') {
    const text = (block as { text?: string }).text
    if (text === undefined || text === '') return undefined
    const bounded = truncateReasoning(text)
    return { kind: 'reasoning', text: bounded.text, truncated: bounded.truncated }
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
