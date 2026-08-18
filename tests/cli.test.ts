/**
 * cli.ts tests: --host origin validation and the idempotent lifecycle gate.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_HOST, createLifecycle, parseHostArg, pumpSettleError } from '../src/cli.js'

test('defaults to the documented loopback host', () => {
  const result = parseHostArg([])
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.origin.origin, DEFAULT_HOST)
})

test('accepts 127.0.0.1 and localhost with a port', () => {
  for (const raw of ['http://127.0.0.1:3080', 'http://localhost:3080', 'http://127.0.0.1']) {
    const result = parseHostArg(['--host', raw])
    assert.equal(result.ok, true, raw)
    if (result.ok) assert.equal(result.origin.origin, new URL(raw).origin)
  }
})

test('rejects non-http schemes', () => {
  const result = parseHostArg(['--host', 'https://127.0.0.1:3080'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /http:\/\//)
})

test('rejects non-loopback hostnames', () => {
  for (const raw of ['http://example.com:3080', 'http://192.168.1.10:3080', 'http://[::1]:3080']) {
    const result = parseHostArg(['--host', raw])
    assert.equal(result.ok, false, raw)
    if (!result.ok) assert.match(result.error, /loopback/)
  }
})

test('rejects credentials, non-root paths, query strings, and fragments', () => {
  const cases: Array<[string, RegExp]> = [
    ['http://user:pass@127.0.0.1:3080', /credentials/],
    ['http://127.0.0.1:3080/some/path', /root path/],
    ['http://127.0.0.1:3080/?q=1', /query/],
    ['http://127.0.0.1:3080/#frag', /query/],
  ]
  for (const [raw, pattern] of cases) {
    const result = parseHostArg(['--host', raw])
    assert.equal(result.ok, false, raw)
    if (!result.ok) assert.match(result.error, pattern)
  }
})

test('rejects unknown options and positional arguments', () => {
  assert.equal(parseHostArg(['--bogus', 'x']).ok, false)
  assert.equal(parseHostArg(['positional']).ok, false)
})

test('rejects malformed URLs', () => {
  const result = parseHostArg(['--host', 'not a url'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid --host URL/)
})

test('lifecycle shutdown is idempotent and ordered', () => {
  const calls: string[] = []
  const gate = createLifecycle({
    abort: () => { calls.push('abort') },
    stop: () => { calls.push('stop') },
    exit: (code) => { calls.push(`exit:${code}`) },
    disposeSignals: () => { calls.push('dispose') },
  })
  gate(0)
  gate(1)
  gate(0)
  assert.deepEqual(calls, ['dispose', 'abort', 'stop', 'exit:0'])
})

test('lifecycle exit carries the first requested code', () => {
  let code = -1
  const gate = createLifecycle({
    abort: () => undefined,
    stop: () => undefined,
    exit: (value) => { code = value },
    disposeSignals: () => undefined,
  })
  gate(2)
  gate(0)
  assert.equal(code, 2)
})

test('lifecycle exit carries the first requested code even when stop throws', () => {
  const calls: string[] = []
  const gate = createLifecycle({
    abort: () => { calls.push('abort') },
    stop: () => { calls.push('stop'); throw new Error('broken fd') },
    exit: (code) => { calls.push(`exit:${code}`) },
    disposeSignals: () => { calls.push('dispose') },
  })
  assert.doesNotThrow(() => gate(1))
  assert.deepEqual(calls, ['dispose', 'abort', 'stop', 'exit:1'])
})

test('rejects duplicate --host options', () => {
  const result = parseHostArg(['--host', 'http://127.0.0.1:3080', '--host', 'http://127.0.0.1:3081'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /at most once/)
})



test('uncaughtException and unhandledRejection route through the shutdown gate', async (t) => {
  const { installFailureHandlers } = await import('../src/cli.js')
  const calls: string[] = []
  const gate = (code: number): void => { calls.push(`gate:${code}`) }
  const handlers: Array<(arg: unknown) => void> = []
  const originalOn = process.on.bind(process)
  const originalRemove = process.removeListener.bind(process)
  t.mock.method(process, 'on', (event: string, handler: (arg: unknown) => void) => {
    if (event === 'uncaughtException' || event === 'unhandledRejection') handlers.push(handler)
    return originalOn(event, handler as never)
  })
  t.mock.method(process, 'removeListener', (event: string, handler: (arg: unknown) => void) => {
    return originalRemove(event, handler as never)
  })
  const dispose = installFailureHandlers(gate)
  // Fire the captured handlers the way Node would.
  for (const handler of handlers) handler(new Error('render blew up'))
  dispose()
  assert.deepEqual(calls, ['gate:1', 'gate:1'])
})

test('pumpSettleError surfaces non-abort rejections and ignores AbortError', () => {
  // The lifecycle gate aborts before exit(), so the controller state cannot
  // distinguish abort-driven from genuine pump rejections; the error name can.
  const surfaced: string[] = []
  assert.equal(pumpSettleError(new DOMException('aborted', 'AbortError'), (m) => surfaced.push(m)), false)
  assert.equal(surfaced.length, 0)
  assert.equal(pumpSettleError(new Error('render blew up'), (m) => surfaced.push(m)), true)
  assert.deepEqual(surfaced, ['render blew up'])
  assert.equal(pumpSettleError('string rejection', (m) => surfaced.push(m)), true)
  assert.deepEqual(surfaced, ['render blew up', 'string rejection'])
})
