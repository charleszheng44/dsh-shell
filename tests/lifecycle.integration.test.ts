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

/**
 * Stub host with one workspace/session and a live prompt queue: pushes a
 * session/queue snapshot right after the mux opens, records
 * session.updateQueue calls, and broadcasts a fresh snapshot after each
 * removal (the client's panel is authoritative from these snapshots).
 */
function startQueueHost(): Promise<{
  server: Server
  origin: string
  updateQueueCalls: Array<{ sessionId: string; itemId: string; action: unknown }>
  respondBodies: Array<{ type: string; rpcId: string; result: unknown }>
  selectModelCalls: unknown[]
  promptCalls: unknown[]
  muxSend: (payload: unknown, rpcId?: string) => void
}> {
  const updateQueueCalls: Array<{ sessionId: string; itemId: string; action: unknown }> = []
  const respondBodies: Array<{ type: string; rpcId: string; result: unknown }> = []
  const selectModelCalls: unknown[] = []
  const promptCalls: unknown[] = []
  const SID = 's1'
  const queue = [
    { id: 'msg-1', placement: 'queued', message: { id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'fix the parser' }], source: { kind: 'user' } } },
    { id: 'msg-2', placement: 'queued', message: { id: 'msg-2', role: 'user', content: [{ type: 'text', text: 'run the tests' }], source: { kind: 'user' } } },
  ]
  let muxSend: (payload: unknown, rpcId?: string) => void = () => {}
  const pushQueueSnapshot = (): void => {
    muxSend({ type: 'session/queue', sessionId: SID, items: queue.map((item) => ({ ...item })) })
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      if (req.url === '/api/respond') {
        const message = JSON.parse(body) as { type: string; rpcId: string; result: unknown }
        respondBodies.push(message)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: true }))
        // Settle the ask this response answers: gating on the rpcId keeps the
        // settle frame behind the request it resolves. The question settle is
        // delayed past the HTTP receipt so the client paints its transient
        // 'Answered' notice before the resolve frame clears it — deterministic
        // order, and the resolve-by-questionRpcId path is genuinely hit.
        if (message.rpcId === 'rpc-appr-e2e') {
          muxSend({ type: 'approval/resolved', sessionId: SID, approvalId: 'appr-e2e', outcome: 'allowed-once' })
        }
        if (message.rpcId === 'rpc-question-1') {
          setTimeout(() => {
            muxSend({ type: 'question/resolved', sessionId: SID, questionRpcId: 'rpc-question-1', outcome: 'answered' })
          }, 100)
        }
        return
      }
      let parsed: { method?: string; rpcId?: string; payload?: { sessionId?: string; itemId?: string; action?: unknown; provider?: string; model?: string } } = {}
      try { parsed = JSON.parse(body) as typeof parsed } catch { /* fall through */ }
      const method = parsed.method ?? ''
      let value: unknown
      switch (method) {
        case 'host.describe':
          value = { version: '0.0.1', cwd: '/tmp', attachedSessions: 0, canOpenPath: false }
          break
        case 'workspace.list':
          value = { items: [{ workspaceId: 'w1', path: '/tmp', title: 'stub', sessionIds: [SID], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], archivedSessionIds: [] }
          break
        case 'session.list':
          value = { items: [{ sessionId: SID, updatedAt: 0, running: false, blank: false, projections: { asOfSeq: 1, values: {
            title: 'stub session',
            tokenUsage: { uncachedInputTokens: 1200, outputTokens: 3400, cacheReadTokens: 0, cacheWriteTokens: 0 },
            contextPressure: { pressureTokens: 90000, contextWindow: 200000 },
          } } }] }
          break
        case 'session.history':
          value = { events: [
            { event: { type: 'user/message', seq: 1, time: 0, surfaceOp: 'append', data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } },
            { event: { type: 'assistant/message', seq: 2, time: 0, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 'a1', role: 'assistant', content: [
              { type: 'reasoning', text: 'think about it' },
              { type: 'text', text: 'ok' },
            ], source: { kind: 'model', provider: 'p' } } } } },
          ], hasMore: false }
          break
        case 'session.updateQueue': {
          const itemId = parsed.payload?.itemId ?? ''
          const action = parsed.payload?.action
          updateQueueCalls.push({ sessionId: parsed.payload?.sessionId ?? '', itemId: String(itemId), action })
          const index = queue.findIndex((item) => item.id === itemId)
          const kind = typeof action === 'object' && action !== null ? (action as { kind?: string }).kind : undefined
          if (index >= 0 && (kind === 'remove' || kind === 'steer')) {
            queue.splice(index, 1)
          }
          pushQueueSnapshot()
          value = { accepted: true }
          break
        }
        case 'session.prompt': {
          promptCalls.push(parsed.payload)
          value = { accepted: true }
          break
        }
        case 'session.models':
          value = {
            current: { provider: 'p1', model: 'm1' },
            routable: true,
            groups: [{
              id: 'p1',
              name: 'Provider One',
              models: [
                { id: 'm1', name: 'Model One' },
                { id: 'm2', name: 'Model Two', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } },
              ],
            }],
            failures: [],
          }
          break
        case 'session.selectModel': {
          selectModelCalls.push(parsed.payload)
          value = { selected: { provider: parsed.payload?.provider ?? '', model: parsed.payload?.model ?? '' } }
          break
        }
        default:
          value = undefined
      }
      if (value === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const rpcId = parsed.rpcId ?? 'stub'
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
    muxSend = (payload: unknown, rpcId = 'stub-mux'): void => {
      const message = JSON.stringify({
        type: 'server-request',
        rpcId,
        method: 'events.mux',
        payload,
      })
      const frame = Buffer.alloc(message.length >= 126 ? 4 + message.length : 2 + message.length)
      frame[0] = 0x81
      if (message.length >= 126) {
        frame[1] = 0x7e
        frame.writeUInt16BE(message.length, 2)
        frame.write(message, 4)
      } else {
        frame[1] = message.length
        frame.write(message, 2)
      }
      socket.write(frame)
    }
    muxSend({ type: 'session/subscribed', sessionId: SID, lastSeq: 0 })
    // The queue snapshot replays on open; the client caches it and seeds
    // the attachment when the user attaches. An approval ask rides along.
    pushQueueSnapshot()
    muxSend({
      type: 'approval/requested',
      sessionId: SID,
      approvalId: 'appr-e2e',
      toolName: 'bash',
      reason: 'run the tests',
    }, 'rpc-appr-e2e')
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
      // Resolve a wrapper, not the value: the upgrade handler assigns the
      // real sender only after the child CLI connects, so a captured value
      // here would be the no-op initializer.
      resolve({ server, origin: `http://127.0.0.1:${address.port}`, updateQueueCalls, respondBodies, selectModelCalls, promptCalls, muxSend: (payload, rpcId) => muxSend(payload, rpcId) })
    })
  })
}

/** Poll a predicate on the accumulated stdout until it holds. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error(`condition never held: ${label}`)
}

test('Ctrl+U pops the last queued message into the composer end to end', async () => {
  const { server, origin, updateQueueCalls, respondBodies, selectModelCalls, promptCalls, muxSend } = await startQueueHost()
  let child: ChildProcess | undefined
  try {
    const spawned = runCli(['--host', origin])
    child = spawned.child
    const { done } = spawned
    const stdoutRef = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutRef.value += chunk.toString() })
    await waitForConnected(child, stdoutRef)
    // The project picker auto-opens at boot: pick the workspace, then the
    // session.
    await waitForStdout(stdoutRef, 'Select project')
    child.stdin?.write('\u001b[B\r')
    await waitForStdout(stdoutRef, 'Select session')
    child.stdin?.write('\r')
    await waitForStdout(stdoutRef, 'Queued follow-up inputs')
    await waitForStdout(stdoutRef, '↳ run the tests')
    assert.equal(updateQueueCalls.length, 0)
    // The Codex-style cursor: DECSCUSR 2 (steady block — the software blink
    // owns the flashing) at start, and the hardware cursor is shown (pi
    // hides it by default; TuiAltScreen was constructed with
    // showHardwareCursor=true).
    assert.ok(stdoutRef.value.includes('\x1b[2 q'), 'DECSCUSR steady block emitted at start')
    child.stdin?.write('\u0015') // Ctrl+U
    // The host sees the remove for the LAST queued item.
    await waitFor(() => updateQueueCalls.length === 1, 'updateQueue call')
    assert.equal(updateQueueCalls[0]?.itemId, 'msg-2')
    assert.deepEqual(updateQueueCalls[0]?.action, { kind: 'remove' })
    // The accumulated stdout keeps old frames, so judge each row by its
    // LAST write (pi erases with \x1b[2K before writing content; a row's
    // final write is the current screen state). The composer row must end
    // on the popped text with no '↳' (the panel rows carry the ↳ prefix),
    // and the panel's final rows must show the surviving item without the
    // removed one — a substring of the stale pre-pop row alone would not
    // satisfy either check.
    const lastWrite = (row: string): string => {
      const parts = row.split('\x1b[2K')
      return parts.at(-1) ?? ''
    }
    await waitFor(() => {
      // Split the accumulated stdout into row segments: pi writes every row
      // with \x1b[{row};1H\x1b[2K, so each segment knows its terminal row
      // (stream adjacency is not screen adjacency — pi skips unchanged rows).
      const segments: Array<{ row: number; text: string }> = []
      let row = 1
      let last = 0
      const position = /\x1b\[(\d+);1H/g
      for (let m = position.exec(stdoutRef.value); m !== null; m = position.exec(stdoutRef.value)) {
        const text = stdoutRef.value.slice(last, m.index)
        if (text !== '') segments.push({ row, text })
        row = Number(m[1])
        last = m.index + m[0].length
      }
      if (last < stdoutRef.value.length) segments.push({ row, text: stdoutRef.value.slice(last) })
      const lastWrite = (text: string): string => {
        const parts = text.split('\x1b[2K')
        return parts.at(-1) ?? ''
      }
      const plain = (text: string): string => lastWrite(text).replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, '')
      // The composer row: the last segment carrying the ❯ prompt and the
      // popped text, with no ↳ (the queue rows carry the prefix).
      let composerRow = -1
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index]
        if (segment !== undefined) {
          const lastSeg = lastWrite(segment.text)
          if (lastSeg.includes('\u276f ') && lastSeg.includes('run the tests') && !lastSeg.includes('↳')) {
            composerRow = segment.row
            break
          }
        }
      }
      if (composerRow === -1) return false
      // The top border corner sits on the row directly above the composer:
      // no blank margin rows inside the box.
      const topBorder = segments.some((segment) => segment.row === composerRow - 1 && plain(segment.text).startsWith('───'))
      const borderAtLeft = segments.some((segment) => plain(segment.text).startsWith('───'))
      // The queue panel sits above the input box.
      const panelRow = segments.filter((segment) => lastWrite(segment.text).includes('fix the parser')).at(-1)?.row ?? -1
      // The panel's final state shows the surviving item without the removed
      // one; the composer row carries the popped text.
      const panelFinal = segments.some((segment) => {
        const lastSeg = lastWrite(segment.text)
        return lastSeg.includes('fix the parser') && !lastSeg.includes('↳ run the tests')
      })
      return topBorder && borderAtLeft && panelFinal
        && panelRow !== -1 && panelRow < composerRow
    }, 'panel shrink and composer restore')
    // With the editor focused, pi's frame ends show the hardware cursor.
    assert.ok(stdoutRef.value.includes('\x1b[?25h'), 'hardware cursor is shown while focused')
    // The thinking chain from history renders as its own block.
    await waitForStdout(stdoutRef, '▍ Thinking')
    await waitForStdout(stdoutRef, 'think about it')
    // The footer already shows the current model next to the context
    // usage, from the models catalog fetched at attach.
    await waitForStdout(stdoutRef, 'Provider One · Model One')
    // Ctrl+O (the universal binding — no terminal ambiguity) lists the
    // models; choosing the second model (which exposes reasoning efforts)
    // chains into the effort picker, where Low is applied.
    child.stdin?.write('\u000f')
    await waitForStdout(stdoutRef, 'Select model')
    child.stdin?.write('\x1b[B\r')
    child.stdin?.write('\x1b[B\r')
    await waitFor(() => selectModelCalls.length === 1, 'selectModel call')
    assert.deepEqual(selectModelCalls[0], { sessionId: 's1', provider: 'p1', model: 'm2', reasoningEffort: 'low' })
    // The label updates to the new model and effort level.
    await waitForStdout(stdoutRef, 'Provider One · Model Two (Low)')
    // Plain Enter still submits from the composer (regression: Ctrl+M and
    // Enter share the CR byte in legacy terminals). Clear the popped text
    // first, then type and submit.
    child.stdin?.write('\x7f'.repeat(14))
    child.stdin?.write('hello')
    child.stdin?.write('\r')
    await waitFor(() => promptCalls.length === 1, 'prompt call')
    assert.deepEqual(promptCalls[0], {
      sessionId: 's1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    })
    // ESC cancels an open picker: after ESC the composer regains input, so
    // typing and Enter submit (if the dialog were still open the keys would
    // go to the SelectList instead).
    child.stdin?.write('\u000f') // Ctrl+O -> model picker
    await waitForStdout(stdoutRef, 'Select model')
    child.stdin?.write('\x1b') // ESC
    await new Promise((resolve) => setTimeout(resolve, 300))
    child.stdin?.write('second')
    child.stdin?.write('\r')
    await waitFor(() => promptCalls.length === 2, 'prompt call after ESC')
    assert.deepEqual(promptCalls[1], {
      sessionId: 's1',
      mode: 'queue',
      content: [{ type: 'text', text: 'second' }],
    })
    // Ctrl+Y steers the remaining queued message into the running agent:
    // the host records the steer, removes it, and the panel clears.
    child.stdin?.write('\u0019') // Ctrl+Y
    await waitFor(() => updateQueueCalls.length === 2, 'steer call')
    assert.equal(updateQueueCalls[1]?.itemId, 'msg-1')
    assert.deepEqual(updateQueueCalls[1]?.action, { kind: 'steer' })
    await waitFor(() => {
      const segments: Array<{ row: number; text: string }> = []
      let row = 1
      let last = 0
      const position = /\x1b\[(\d+);1H/g
      for (let m = position.exec(stdoutRef.value); m !== null; m = position.exec(stdoutRef.value)) {
        const text = stdoutRef.value.slice(last, m.index)
        if (text !== '') segments.push({ row, text })
        row = Number(m[1])
        last = m.index + m[0].length
      }
      const lastWrite = (text: string): string => {
        const parts = text.split('\x1b[2K')
        return parts.at(-1) ?? ''
      }
      // The accumulated stream keeps every frame; judge the FINAL state per
      // row (the last write wins).
      const byRow = new Map<number, string>()
      for (const segment of segments) {
        byRow.set(segment.row, lastWrite(segment.text))
      }
      return ![...byRow.values()].some((text) => text.includes('fix the parser'))
    }, 'queue panel cleared after steer')
    // The host's approval ask renders as a card; Ctrl+A answers it by
    // echoing the frame's rpcId with the allowed-once outcome.
    await waitForStdout(stdoutRef, 'Approval: Bash')
    child.stdin?.write('\u0001') // Ctrl+A
    await waitFor(() => respondBodies.length === 1, 'approval response')
    const approval = respondBodies[0]
    assert.equal(approval?.rpcId, 'rpc-appr-e2e')
    assert.deepEqual(approval?.result, {
      ok: true,
      value: { sessionId: 's1', approvalId: 'appr-e2e', outcome: 'allowed-once' },
    })
    // The host's question ask renders as a card; answering '1' picks the
    // first option and echoes the request's rpcId on /api/respond. The
    // frame is pushed only now: while a question is open the composer
    // answers it, so queue editing is gated and the earlier steps must run
    // with none pending.
    muxSend({
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'qa', question: 'Approve the change?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, 'rpc-question-1')
    await waitForStdout(stdoutRef, 'Approve the change?')
    child.stdin?.write('1')
    child.stdin?.write('\r')
    await waitFor(() => respondBodies.length === 2, 'question response')
    const question = respondBodies[1]
    assert.equal(question?.rpcId, 'rpc-question-1')
    assert.deepEqual(question?.result, {
      ok: true,
      value: { sessionId: 's1', answer: { answers: [{ id: 'qa', selected: ['Yes'] }] } },
    })
    // The accepted receipt sets the transient 'Answered' notice; the delayed
    // question/resolved frame then clears it, so the resolve-by-questionRpcId
    // path is exercised end to end — a broken settle would leave the notice
    // stuck and fail this step.
    await waitForStdout(stdoutRef, '· Answered')
    await waitFor(() => {
      const segments: Array<{ row: number; text: string }> = []
      let row = 1
      let last = 0
      const position = /\x1b\[(\d+);1H/g
      for (let m = position.exec(stdoutRef.value); m !== null; m = position.exec(stdoutRef.value)) {
        const text = stdoutRef.value.slice(last, m.index)
        if (text !== '') segments.push({ row, text })
        row = Number(m[1])
        last = m.index + m[0].length
      }
      if (last < stdoutRef.value.length) segments.push({ row, text: stdoutRef.value.slice(last) })
      // Old frames accumulate, so the header row's LAST write decides.
      const header = segments.filter((segment) => segment.row === 1).at(-1)
      return header !== undefined && !header.text.includes('· Answered')
    }, 'question/resolved clears the Answered notice')
    // The software blink must cycle on -> off -> on: only the 530ms timer
    // can hide the cursor again after a focused frame showed it. Poll so a
    // full half-second cycle has time to elapse.
    await waitFor(() => {
      const blinkOut = stdoutRef.value
      const h1 = blinkOut.indexOf('\x1b[?25h')
      const l1 = h1 === -1 ? -1 : blinkOut.indexOf('\x1b[?25l', h1)
      const h2 = l1 === -1 ? -1 : blinkOut.indexOf('\x1b[?25h', l1)
      return h1 !== -1 && l1 !== -1 && h2 !== -1
    }, 'the software blink cycles on-off-on')
    child.stdin?.write('\u0003') // Ctrl+C
    const result = await done
    assert.equal(result.code, 0)
    assert.equal(result.restored, true)
    // stop() re-applies the default DECSCUSR 0 after the alt-screen exit.
    assert.ok((result.stdout.match(/\x1b\[0 q/g) ?? []).length >= 1, 'cursor style restored at stop')
    // The software blink toggles the hardware cursor: more than one on-phase.
    assert.ok((result.stdout.match(/\x1b\[\?25h/g) ?? []).length >= 2, 'cursor blink toggles')
  } finally {
    // A failed assertion must not strand the spawned CLI on the stub's
    // keep-alive connections (which would also wedge server.close()).
    child?.kill()
    server.close()
  }
})
