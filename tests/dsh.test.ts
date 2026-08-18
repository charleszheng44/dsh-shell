/**
 * dsh.ts adapter tests: the port folds unary transport failures into the same
 * RpcResult shape as DSH business errors, and NodeApiClient resolves against
 * the explicit origin.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'

import { NodeApiClient, createDshPort, type DshPort, type PortClient } from '../src/dsh.js'

/** Minimal client stub: only the members the port touches. */
function stubClient(overrides: {
  host?: Partial<PortClient['host']>
  workspace?: Partial<PortClient['workspace']>
  sessions?: Partial<PortClient['sessions']>
  events?: Partial<PortClient['events']>
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
      prompt: async () => ok({ accepted: true }),
    },
    events: {
      mux: async function* mux() { return },
    },
  }
  return {
    host: { ...base.host, ...overrides.host },
    workspace: { ...base.workspace, ...overrides.workspace },
    sessions: { ...base.sessions, ...overrides.sessions },
    events: { ...base.events, ...overrides.events },
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

test('NodeApiClient mux stream opens, yields frames, and abort closes the socket', async (t) => {
  const { createServer } = await import('node:http')
  const { createHash } = await import('node:crypto')
  const { server, port } = await new Promise<{ server: import('node:http').Server; port: number }>((resolve) => {
    const srv = createServer()
    srv.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key']
      if (typeof key !== 'string') { socket.destroy(); return }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
      const payload = JSON.stringify({ type: 'server-request', rpcId: 'r1', method: 'events.mux', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } })
      const frame = Buffer.alloc(payload.length >= 126 ? 4 + payload.length : 2 + payload.length)
      frame[0] = 0x81
      if (payload.length >= 126) {
        frame[1] = 0x7e
        frame.writeUInt16BE(payload.length, 2)
        frame.write(payload, 4)
      } else {
        frame[1] = payload.length
        frame.write(payload, 2)
      }
      socket.write(frame)
      socket.on('data', (chunk: Buffer) => {
        const first = chunk[0]
        if (chunk.length >= 2 && first !== undefined && (first & 0x0f) === 0x8) {
          socket.write(Buffer.from([0x88, 0x00]))
          socket.end()
        }
      })
    })
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: (srv.address() as { port: number }).port }))
  })
  t.after(() => { server.close() })

  const client = new NodeApiClient(new URL(`http://127.0.0.1:${port}`))
  const abort = new AbortController()
  let opened = false
  const frames: string[] = []
  const pump = (async () => {
    for await (const frame of client.events.mux({}, abort.signal, () => { opened = true })) {
      frames.push(frame.payload.type)
    }
  })()
  // Wait for the frame and onOpen via the event loop.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(opened, true)
  assert.deepEqual(frames, ['session/subscribed'])
  abort.abort()
  await pump
})

test('createDshPort.prompt sends the unsanitized text as one queue-mode part', async () => {
  let seen: unknown
  const client = stubClient({
    sessions: {
      prompt: async (payload) => {
        seen = payload
        return ok({ accepted: true })
      },
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.prompt('session-abc' as never, '  hello \u0001 raw  ', undefined)
  assert.equal(result.ok, true)
  assert.deepEqual(seen, {
    sessionId: 'session-abc',
    mode: 'queue',
    content: [{ type: 'text', text: '  hello \u0001 raw  ' }],
  })
})

test('createDshPort.prompt folds transport throws into the error branch', async () => {
  const client = stubClient({
    sessions: {
      prompt: async () => { throw new Error('connection lost') },
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.prompt('s1' as never, 'hello', undefined)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error.message, /connection lost/)
})

test('read calls retry once on a stale-socket reset and succeed', async () => {
  // The host closes idle keep-alive sockets; the first call lands on the
  // stale socket (ECONNRESET), the retry opens a fresh connection.
  let calls = 0
  const client = stubClient({
    sessions: {
      history: async () => {
        calls += 1
        if (calls === 1) {
          const error = new Error('fetch failed')
          error.cause = new Error('read ECONNRESET')
          throw error
        }
        return ok({ events: [], hasMore: false })
      },
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.loadHistory('s1' as never, undefined)
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

test('a non-connection error on a read is not retried', async () => {
  let calls = 0
  const client = stubClient({
    sessions: {
      history: async () => {
        calls += 1
        throw new Error('boom')
      },
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.loadHistory('s1' as never, undefined)
  assert.equal(result.ok, false)
  assert.equal(calls, 1)
})

test('prompt is never retried on a connection error', async () => {
  // A retried prompt could be admitted twice, so the write path folds the
  // error instead of retrying.
  let calls = 0
  const client = stubClient({
    sessions: {
      prompt: async () => {
        calls += 1
        const error = new Error('fetch failed')
        error.cause = new Error('read ECONNRESET')
        throw error
      },
    },
  })
  const port: DshPort = createDshPort(client)
  const result = await port.prompt('s1' as never, 'hello', undefined)
  assert.equal(result.ok, false)
  assert.equal(calls, 1)
})
