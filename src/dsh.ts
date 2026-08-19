/**
 * DSH network adapter and the narrow DshPort seam.
 *
 * The adapter subclasses the published `AbstractApiClient` from
 * `@deepseek-ai/dsh-host-apiproxy/client` with a Node transport bound to an
 * explicit loopback origin. The DshPort interface is the one seam the rest of
 * the TUI depends on, so orchestration tests can substitute a small in-memory
 * fake instead of faking the complete DSH API.
 *
 * Protocol compatibility: the client package version is pinned exactly in
 * package.json, and every response is validated against the published zod
 * schemas inside the client. A host whose wire format diverges fails
 * host.describe loudly, before any selector or stream opens. The design doc's
 * explicit numeric protocolVersion gate (its PR 1) is deferred until
 * deepseek-harness publishes that field.
 */

import { AbstractApiClient, type IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  RpcId,
  serverRequestSchema,
  transportError,
  type ClientResponse,
  type RpcReceipt,
  type RpcResponse,
  type RpcRequest,
  type RpcResult,
  type ResponseValue,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type {
  HistoryEntry,
  ModelSelection,
  MuxFrame,
  QueueAction,
  SessionModels,
  SessionSummary,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** host.describe response value, exactly as the published schema defines it. */
export type HostDescription = ResponseValue<'host.describe'>

/** The narrow network seam the TUI consumes. PR 3 widens it with stream and prompt. */
export interface DshPort {
  describe(signal?: AbortSignal): Promise<RpcResult<HostDescription>>
  listWorkspaces(signal?: AbortSignal): Promise<RpcResult<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
  }>>
  listSessions(signal?: AbortSignal): Promise<RpcResult<{
    items: SessionSummary[]
  }>>
  loadHistory(sessionId: SessionId, signal?: AbortSignal): Promise<RpcResult<{
    events: HistoryEntry[]
    hasMore: boolean
  }>>
  /** Live mux stream: yields stripped MuxFrames once the socket is open. The
   *  envelope's rpcId rides along when present — question/requested answers
   *  must echo it on /api/respond. */
  stream(signal: AbortSignal, onOpen: () => void): AsyncIterable<MuxFrame & { rpcId?: RpcId }>
  /** Submit one plain-text prompt to the attached session (queue mode). */
  prompt(sessionId: SessionId, text: string, signal?: AbortSignal): Promise<RpcResult<{
    accepted: true
  }>>
  /** Answer a host question (or approval) by echoing the server-request's
   *  rpcId on POST /api/respond. Never retried — a late duplicate response
   *  would settle a request that may already be gone. */
  respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt>
  /** Mutate one still-pending queue item (remove/edit). A write: never
   *  retried, so a duplicate cannot apply twice. */
  updateQueue(sessionId: SessionId, itemId: MessageId, action: QueueAction, signal?: AbortSignal): Promise<RpcResult<{
    accepted: true
  }>>
  /** The session's selectable models and current selection. */
  listModels(sessionId: SessionId, signal?: AbortSignal): Promise<RpcResult<SessionModels>>
  /** Switch the session's model (and optionally reasoning effort). A write:
   *  never retried. */
  selectModel(sessionId: SessionId, selection: {
    provider: string
    model: string
    reasoningEffort?: string
  }, signal?: AbortSignal): Promise<RpcResult<{
    selected: ModelSelection
  }>>
  /** Create (or idempotently adopt) a project over an EXISTING directory
   *  (the host does no mkdir). A write: never retried. */
  createWorkspace(path: string, signal?: AbortSignal): Promise<RpcResult<{
    workspace: WorkspaceView
    created: boolean
  }>>
  /** Create a session (and its idle agent) in the given project; an omitted
   *  project uses the host cwd. A write: never retried. */
  createSession(workspaceId: WorkspaceId | undefined, signal?: AbortSignal): Promise<RpcResult<{
    sessionId: SessionId
  }>>
}

/** Upper bound on one WebSocket message: a hostile host must not be able to
 *  OOM the client with a single giant frame. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Connection-level fetch errors: a stale keep-alive socket the host closed
 *  while we idled, or a socket reset mid-request. These are safe to retry
 *  once — the request never produced a response, and the retry opens a fresh
 *  connection. */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.cause instanceof Error ? error.cause.message : error.message
  return /ECONNRESET|UND_ERR_SOCKET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)
}

/** One unary call folded into the RpcResult error branch on any transport
 *  failure. Read calls retry once on connection-level errors: the host's HTTP
 *  server closes keep-alive sockets after a few seconds of idle, so a read
 *  issued after browsing the picker can land on a stale socket and be reset;
 *  the retry uses a fresh connection. Prompt (a write) never retries — a
 *  retried prompt could be admitted twice. */
async function unary<T>(call: () => Promise<RpcResponse<T>>, retry = false): Promise<RpcResult<T>> {
  try {
    return (await call()).result
  } catch (error) {
    if (retry && isConnectionError(error)) {
      try {
        return (await call()).result
      } catch (retryError) {
        return transportError<T>(retryError)
      }
    }
    return transportError<T>(error)
  }
}

/** The client members the port uses; narrower than IApiClient so fakes stay small. */
export interface PortClient {
  host: {
    describe(payload: {}, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'host.describe'>>>
  }
  workspace: {
    list(payload: {}, signal?: AbortSignal): Promise<RpcResponse<{
      items: WorkspaceView[]
      archivedSessionIds: SessionId[]
    }>>
    create(payload: { path: string }, signal?: AbortSignal): Promise<RpcResponse<{
      workspace: WorkspaceView
      created: boolean
    }>>
  }
  sessions: {
    list(payload: {}, signal?: AbortSignal): Promise<RpcResponse<{
      items: SessionSummary[]
    }>>
    history(payload: { sessionId: SessionId }, signal?: AbortSignal): Promise<RpcResponse<{
      events: HistoryEntry[]
      hasMore: boolean
    }>>
    prompt(payload: {
      sessionId: SessionId
      mode: 'queue' | 'steer'
      content: Array<{ type: 'text'; text: string }>
    }, signal?: AbortSignal): Promise<RpcResponse<{
      accepted: true
      command?: { kind: 'success'; text?: string }
    }>>
    updateQueue(payload: {
      sessionId: SessionId
      itemId: MessageId
      action: QueueAction
    }, signal?: AbortSignal): Promise<RpcResponse<{
      accepted: true
    }>>
    models(payload: {
      sessionId: SessionId
    }, signal?: AbortSignal): Promise<RpcResponse<SessionModels>>
    selectModel(payload: {
      sessionId: SessionId
      provider: string
      model: string
      reasoningEffort?: string
    }, signal?: AbortSignal): Promise<RpcResponse<{
      selected: ModelSelection
    }>>
    create(payload: {
      workspaceId?: WorkspaceId
      cwd?: string
      sessionId?: SessionId
      agentPreset?: string
    }, signal?: AbortSignal): Promise<RpcResponse<{
      sessionId: SessionId
      agentPreset?: string
    }>>
  }
  /** Answer a host question by echoing its server-request rpcId. */
  respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt>
  events: {
    mux(payload: MuxPayload, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>>
  }
}

/** Direct adapter: DshPort over the published client, folding transport errors. */
export function createDshPort(client: PortClient): DshPort {
  return {
    describe: (signal) => unary(() => client.host.describe({}, signal), true),
    listWorkspaces: (signal) => unary(() => client.workspace.list({}, signal), true),
    listSessions: (signal) => unary(() => client.sessions.list({}, signal), true),
    loadHistory: (sessionId, signal) => unary(() => client.sessions.history({ sessionId }, signal), true),
    prompt: (sessionId, text, signal) => unary(() => client.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, signal)),
    // A transport failure folds to a bad-response receipt so the answer
    // flow can surface a notice; the host treats late duplicates as
    // not-pending.
    respond: (message, signal) => client.respond(message, signal)
      .catch(() => ({ accepted: false, reason: 'bad-response' })),
    updateQueue: (sessionId, itemId, action, signal) => unary(() => client.sessions.updateQueue({
      sessionId,
      itemId,
      action,
    }, signal), false),
    listModels: (sessionId, signal) => unary(() => client.sessions.models({ sessionId }, signal), true),
    selectModel: (sessionId, selection, signal) => unary(() => client.sessions.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }, signal), false),
    createWorkspace: (path, signal) => unary(() => client.workspace.create({ path }, signal), false),
    createSession: (workspaceId, signal) => unary(() => client.sessions.create(
      workspaceId === undefined ? {} : { workspaceId },
      signal,
    ), false),
    async *stream(signal, onOpen) {
      // Strip the RPC envelope from every mux frame but keep its rpcId (the
      // question/requested answer must echo it); stream errors surface as the
      // iterable ending, which the app treats as disconnected.
      for await (const frame of client.events.mux({}, signal, onOpen)) {
        yield { ...frame.payload, rpcId: frame.rpcId }
      }
    },
  }
}

/**
 * Node transport bound to one explicit origin. doFetch uses the global fetch;
 * mux/host streams use the global WebSocket with a downlink reader that
 * mirrors the browser client's. Aborting the caller's signal closes the
 * socket, so shutdown needs no forced exit or timeout.
 */
export class NodeApiClient extends AbstractApiClient {
  constructor(private readonly origin: URL) {
    super()
  }

  protected override resolveBase(): string {
    return this.origin.origin
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override openMux(
    _payload: MuxPayload,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: Array<{ kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }> = []
    let dropped = 0
    let wake: (() => void) | undefined
    const enqueue = (item: { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        if (event.data.length > MAX_FRAME_BYTES) throw new Error('oversized WebSocket frame')
        const full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      } catch (error) {
        // DSH-derived bytes must not reach the raw-mode terminal, even in a
        // diagnostic: log a static message only, and rate-limit so a flood of
        // malformed frames cannot spam stderr.
        dropped += 1
        if (dropped === 1 || dropped === 10 || dropped % 100 === 0) {
          console.error(`[dsh-shell] dropping malformed WebSocket frame on ${path} (${dropped} dropped)`)
        }
      }
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close()
      }
    }
    const handleError = (): void => { enqueue({ kind: 'end' }) }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('error', handleError)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('close', handleClose)
      handleAbort()
    }
  }
}

/** The published events API shape used to type openMux/openHost payloads. */
type ApiProxyEvents = NonNullable<IApiClient['events']>
// The mux payload the published client takes directly (not RpcRequest-wrapped).
type MuxPayload = Parameters<ApiProxyEvents['mux']>[0]
