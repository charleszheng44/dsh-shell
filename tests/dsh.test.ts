/**
 * dsh.ts adapter tests: the port folds unary transport failures into the same
 * RpcResult shape as DSH business errors, and NodeApiClient resolves against
 * the explicit origin.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'

import { NodeApiClient, createDshPort, type DshPort, type PortClient } from '../src/dsh.js'

/** Minimal client stub: only the members the port touches. */
function stubClient(overrides: {
  host?: Partial<PortClient['host']>
  workspace?: Partial<PortClient['workspace']>
  sessions?: Partial<PortClient['sessions']>
} = {}): PortClient {
  const base: PortClient = {
    host: {
      describe: async () => ok({} as never),
    },
    workspace: {
      list: async () => ok({ items: [], archivedSessionIds: [] }),
    },
    sessions: {
      list: async () => ok({ items: [] }),
      history: async () => ok({ events: [], hasMore: false }),
    },
  }
  return {
    host: { ...base.host, ...overrides.host },
    workspace: { ...base.workspace, ...overrides.workspace },
    sessions: { ...base.sessions, ...overrides.sessions },
  }
}

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'rpc-1' as never, result: { ok: true, value } }
}

function businessError<T>(code: string): RpcResponse<T> {
  return {
    rpcId: 'rpc-1' as never,
    result: { ok: false, error: { code, message: `business ${code}`, details: {} } } as never,
  }
}

test('createDshPort folds a transport throw into the RpcResult error branch', async () => {
  const client = stubClient({
    host: {
      describe: async () => { throw new Error('connection refused') },
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.describe()
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /connection refused/)
  }
})

test('createDshPort passes DSH business errors through unchanged', async () => {
  const client = stubClient({
    sessions: {
      list: async () => businessError('session-not-found'),
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.listSessions()
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'session-not-found')
  }
})

test('createDshPort returns values on success', async () => {
  const client = stubClient({
    sessions: {
      history: async () => ok({ events: [], hasMore: true }),
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.loadHistory('session-1' as never)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.hasMore, true)
  }
})

test('createDshPort sends the selected session id to session.history', async () => {
  let seen: unknown
  const client = stubClient({
    sessions: {
      history: async (payload) => {
        seen = payload
        return ok({ events: [], hasMore: false })
      },
    },
  })
  const port: DshPort = createDshPort(client)
  await port.loadHistory('session-abc' as never)
  assert.deepEqual(seen, { sessionId: 'session-abc' })
})

test('NodeApiClient resolves unary URLs against the explicit origin', async () => {
  const origin = new URL('http://127.0.0.1:3080')
  const client = new NodeApiClient(origin)
  // resolveBase is protected; exercise it through the published client's
  // unary path with a fetch spy that records the requested URL.
  const requested: string[] = []
  const originalFetch = globalThis.fetch
  const fetchSpy: typeof fetch = async (input, init) => {
    requested.push(String(input))
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: body?.rpcId ?? '',
      result: {
        ok: true,
        value: {
          version: '0.0.1',
          cwd: '/tmp',
          attachedSessions: 0,
          canOpenPath: false,
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  globalThis.fetch = fetchSpy
  try {
    await client.host.describe({}, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requested.length, 1)
  assert.ok(requested[0]?.startsWith('http://127.0.0.1:3080/api/host.describe'))
})
