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

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  transportError,
  type RpcResponse,
  type RpcResult,
  type ResponseValue,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  HistoryEntry,
  SessionSummary,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
}

/** One unary call folded into the RpcResult error branch on any transport failure. */
async function unary<T>(call: () => Promise<RpcResponse<T>>): Promise<RpcResult<T>> {
  try {
    return (await call()).result
  } catch (error) {
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
  }
  sessions: {
    list(payload: {}, signal?: AbortSignal): Promise<RpcResponse<{
      items: SessionSummary[]
    }>>
    history(payload: { sessionId: SessionId }, signal?: AbortSignal): Promise<RpcResponse<{
      events: HistoryEntry[]
      hasMore: boolean
    }>>
  }
}

/** Direct adapter: DshPort over the published client, folding transport errors. */
export function createDshPort(client: PortClient): DshPort {
  return {
    describe: (signal) => unary(() => client.host.describe({}, signal)),
    listWorkspaces: (signal) => unary(() => client.workspace.list({}, signal)),
    listSessions: (signal) => unary(() => client.sessions.list({}, signal)),
    loadHistory: (sessionId, signal) => unary(() => client.sessions.history({ sessionId }, signal)),
  }
}

/**
 * Node transport bound to one explicit origin. doFetch uses the global fetch,
 * so unary calls work without any browser global; the WebSocket downlink
 * reader for mux/host streams lands with PR 3's stream widening.
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
}
