/**
 * cli.ts lifecycle integration tests: drive the real entry (src/cli.ts through
 * the tsx loader) against a stub DSH HTTP server started inside the test, and
 * verify that Ctrl+C, OS SIGINT, SIGTERM, boot failure, and repeated shutdown
 * each stop the terminal exactly once (alternate-screen restore sequence) and
 * exit with the documented status. The stub host keeps the tests hermetic:
 * no live DSH instance is required.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'

const ENTRY = new URL('../src/cli.ts', import.meta.url).pathname

/** Minimal stub DSH host: answers the three list/describe calls the TUI makes
 *  at boot, and accepts the events.mux WebSocket upgrade with a subscribed
 *  frame so the TUI's stream readiness resolves. With dropMux the socket is
 *  destroyed shortly after the subscribed frame to simulate a stream failure. */
function startStubHost(options: { dropMux?: boolean } = {}): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      let method = ''
      try {
        method = (JSON.parse(body) as { method?: string }).method ?? ''
      } catch {
        method = ''
      }
      let value: unknown
      switch (method) {
        case 'host.describe':
          value = { version: '0.0.1', cwd: '/tmp', attachedSessions: 0, canOpenPath: false }
          break
        case 'workspace.list':
          value = { items: [], archivedSessionIds: [] }
          break
        case 'session.list':
          value = { items: [] }
          break
        default:
          value = undefined
      }
      if (value === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const rpcId = (JSON.parse(body) as { rpcId?: string }).rpcId ?? 'stub'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
    })
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if (req.url !== '/api/events.mux') {
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    // One unmasked text frame: session/subscribed for the attached session.
    const payload = JSON.stringify({
      type: 'server-request',
      rpcId: 'stub-mux',
      method: 'events.mux',
      payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 },
    })
    // Server-to-client text frame; payloads >= 126 bytes need the extended
    // length form (0x7E + 16-bit length). Never set the mask bit.
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
    if (options.dropMux === true) {
      // Simulate the host dropping the stream after readiness: the TUI must
      // show Disconnected and stay responsive to Ctrl+C.
      setTimeout(() => socket.destroy(), 30)
      return
    }
    // Answer the client's close frame so the pump settles naturally instead
    // of only via the CLI's bounded timeout.
    socket.on('data', (chunk: Buffer) => {
      const first = chunk[0]
      if (chunk.length >= 2 && first !== undefined && (first & 0x0f) === 0x8) {
        const reply = Buffer.from([0x88, 0x00])
        socket.write(reply)
        socket.end()
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ server, origin: `http://127.0.0.1:${address.port}` })
    })
  })
}

/** Spawn the CLI with a pipe stdin; resolves {code, signal, restored}. */
function runCli(args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; restored: boolean; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; restored: boolean; stdout: string; stderr: string }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal, restored: stdout.includes('\x1b[?1049l'), stdout, stderr })
    })
  })
  return { child, done }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Wait until the TUI has connected (host.describe succeeded) by polling stdout. */
async function waitForConnected(child: ChildProcess, stdoutRef: { value: string }, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stdoutRef.value.includes('connected')) return
    await sleep(50)
  }
  throw new Error('TUI did not reach the connected state in time')
}

test('boot failure exits nonzero, restores the terminal, and prints the origin', async () => {
  const { child, done } = runCli(['--host', 'http://127.0.0.1:59999'])
  const result = await done
  child.kill()
  assert.equal(result.code, 1)
  assert.equal(result.restored, true)
  assert.match(result.stderr, /http:\/\/127\.0\.0\.1:59999/)
})

test('Ctrl+C (ESC byte) quits with code 0 and restores the terminal', async () => {
  const { server, origin } = await startStubHost()
  try {
    const { child, done } = runCli(['--host', origin])
    const stdoutRef = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutRef.value += chunk.toString() })
    await waitForConnected(child, stdoutRef)
    child.stdin?.write('\u0003') // Ctrl+C
    const result = await done
    assert.equal(result.code, 0)
    assert.equal(result.restored, true)
  } finally {
    server.close()
  }
})

test('OS SIGINT exits with 128+2 and restores the terminal exactly once', async () => {
  const { server, origin } = await startStubHost()
  try {
    const { child, done } = runCli(['--host', origin])
    const stdoutRef = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutRef.value += chunk.toString() })
    await waitForConnected(child, stdoutRef)
    child.kill('SIGINT')
    const result = await done
    assert.equal(result.code, 130)
    assert.equal(result.restored, true)
    const leaves = result.stdout.split('\x1b[?1049l').length - 1
    assert.equal(leaves, 1)
  } finally {
    server.close()
  }
})

test('OS SIGTERM exits with 128+15 and restores the terminal exactly once', async () => {
  const { server, origin } = await startStubHost()
  try {
    const { child, done } = runCli(['--host', origin])
    const stdoutRef = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutRef.value += chunk.toString() })
    await waitForConnected(child, stdoutRef)
    child.kill('SIGTERM')
    const result = await done
    assert.equal(result.code, 143)
    assert.equal(result.restored, true)
    const leaves = result.stdout.split('\x1b[?1049l').length - 1
    assert.equal(leaves, 1)
  } finally {
    server.close()
  }
})

test('repeated shutdown restores the terminal once', async () => {
  const { server, origin } = await startStubHost()
  try {
    const { child, done } = runCli(['--host', origin])
    const stdoutRef = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutRef.value += chunk.toString() })
    await waitForConnected(child, stdoutRef)
    child.kill('SIGTERM')
    child.kill('SIGINT') // second request must be ignored by the idempotent gate
    const result = await done
    // Which signal wins the race is nondeterministic; both map to a signal exit
    // code and, crucially, the terminal is restored exactly once.
    assert.ok(result.code === 130 || result.code === 143, `unexpected exit code ${result.code}`)
    const leaves = result.stdout.split('\x1b[?1049l').length - 1
    assert.equal(leaves, 1)
  } finally {
    server.close()
  }
})

/** Wait until the TUI's stdout contains a substring (polling like waitForConnected). */
async function waitForStdout(stdoutRef: { value: string }, needle: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stdoutRef.value.includes(needle)) return
    await sleep(50)
  }
  throw new Error(`TUI stdout never contained ${JSON.stringify(needle)}`)
}

test('a dropped mux stream shows Disconnected and Ctrl+C still restores once', async () => {
  const { server, origin } = await startStubHost({ dropMux: true })
  try {
    const { child, done } = runCli(['--host', origin])
    const stdoutRef = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutRef.value += chunk.toString() })
    await waitForConnected(child, stdoutRef)
    // The host dropped the socket: the footer must show Disconnected instead
    // of hanging or retrying, and the terminal stays interactive.
    await waitForStdout(stdoutRef, 'Disconnected')
    child.stdin?.write('\u0003') // Ctrl+C
    const result = await done
    assert.equal(result.code, 0)
    assert.equal(result.restored, true)
  } finally {
    server.close()
  }
})
