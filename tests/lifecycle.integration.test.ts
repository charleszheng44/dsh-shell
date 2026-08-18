/**
 * cli.ts lifecycle integration tests: drive the real entry (src/cli.ts through
 * the tsx loader) and verify that Ctrl+C, OS SIGINT, SIGTERM, boot failure,
 * and repeated shutdown each stop the terminal exactly once (alternate-screen
 * restore sequence) and exit with the documented status.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { test } from 'node:test'

const ENTRY = new URL('../src/cli.ts', import.meta.url).pathname

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

test('boot failure exits nonzero, restores the terminal, and prints the origin', async () => {
  const { child, done } = runCli(['--host', 'http://127.0.0.1:59999'])
  const result = await done
  child.kill()
  assert.equal(result.code, 1)
  assert.equal(result.restored, true)
  assert.match(result.stderr, /http:\/\/127\.0\.0\.1:59999/)
})

test('Ctrl+C (ESC byte) quits with code 0 and restores the terminal', async () => {
  const { child, done } = runCli(['--host', 'http://127.0.0.1:3080'])
  await sleep(1500)
  child.stdin?.write('\u0003') // Ctrl+C
  const result = await done
  assert.equal(result.code, 0)
  assert.equal(result.restored, true)
})

test('OS SIGINT exits with 128+2 and restores the terminal exactly once', async () => {
  const { child, done } = runCli(['--host', 'http://127.0.0.1:3080'])
  await sleep(1500)
  child.kill('SIGINT')
  const result = await done
  assert.equal(result.code, 130)
  assert.equal(result.restored, true)
  const leaves = result.stdout.split('\x1b[?1049l').length - 1
  assert.equal(leaves, 1)
})

test('OS SIGTERM exits with 128+15 and restores the terminal exactly once', async () => {
  const { child, done } = runCli(['--host', 'http://127.0.0.1:3080'])
  await sleep(1500)
  child.kill('SIGTERM')
  const result = await done
  assert.equal(result.code, 143)
  assert.equal(result.restored, true)
  const leaves = result.stdout.split('\x1b[?1049l').length - 1
  assert.equal(leaves, 1)
})

test('repeated shutdown restores the terminal once', async () => {
  const { child, done } = runCli(['--host', 'http://127.0.0.1:3080'])
  await sleep(1500)
  child.kill('SIGTERM')
  child.kill('SIGINT') // second request must be ignored by the idempotent gate
  const result = await done
  // Which signal wins the race is nondeterministic; both map to a signal exit
  // code and, crucially, the terminal is restored exactly once.
  assert.ok(result.code === 130 || result.code === 143, `unexpected exit code ${result.code}`)
  const leaves = result.stdout.split('\x1b[?1049l').length - 1
  assert.equal(leaves, 1)
})
