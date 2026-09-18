/**
 * herdr.ts tests: the state mapping, and the two properties that keep
 * reporting safe — it is inert outside a Herdr pane, and it speaks only on a
 * transition (setState runs once per streamed frame).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHerdrReporter, herdrStateFor, type HerdrStateView } from '../src/herdr.js'

/** A pane inside Herdr, with the variables Herdr injects. */
const IN_HERDR = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/usr/bin/herdr' }
const SOURCE = ['--source', 'custom:dsh-shell', '--agent', 'deepseek']

/** Attached session; `turnActive`/pending defaults describe a ready prompt. */
function attached(
  overrides: Partial<{
    turnActive: number | undefined
    pendingQuestions: readonly unknown[]
    pendingApprovals: readonly unknown[]
  }> = {},
): HerdrStateView {
  return {
    attachment: {
      phase: 'attached',
      turnActive: undefined,
      pendingQuestions: [],
      pendingApprovals: [],
      ...overrides,
    },
  }
}

/** Recording spawn sink, so tests never launch a real process. */
function recorder(): { calls: string[][]; spawn: (bin: string, args: readonly string[]) => void } {
  const calls: string[][] = []
  return { calls, spawn: (_bin, args) => { calls.push([...args]) } }
}

/** The argv of call `index`, asserted to exist. */
function argv(calls: string[][], index: number): string[] {
  const call = calls[index]
  assert.ok(call !== undefined, `expected a call at index ${index}`)
  return call
}

/** The value following `flag` in an argv. */
function flagValue(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1]
}

test('herdrStateFor maps attachment state to the Herdr vocabulary', () => {
  assert.equal(herdrStateFor(attached()), 'idle')
  assert.equal(herdrStateFor(attached({ turnActive: 3 })), 'working')
  assert.equal(herdrStateFor(attached({ pendingApprovals: [{}, {}] })), 'blocked')
  assert.equal(herdrStateFor(attached({ pendingQuestions: [{}] })), 'blocked')
  // An open request is what the running turn is waiting on, so it wins.
  assert.equal(herdrStateFor(attached({ turnActive: 3, pendingApprovals: [{}] })), 'blocked')
  // No session attached means nothing is running or waiting.
  assert.equal(herdrStateFor({ attachment: { phase: 'none' } }), 'idle')
  assert.equal(herdrStateFor({ attachment: { phase: 'loading' } }), 'idle')
})

test('reporting is inert outside a Herdr pane', () => {
  for (const env of [
    {},                                                    // not under Herdr at all
    { ...IN_HERDR, HERDR_ENV: undefined },                 // env var absent
    { ...IN_HERDR, HERDR_ENV: '0' },                       // explicitly not Herdr
    { ...IN_HERDR, HERDR_PANE_ID: undefined },             // nowhere to report
    { ...IN_HERDR, HERDR_BIN_PATH: undefined },            // nothing to report with
  ]) {
    const rec = recorder()
    const reporter = createHerdrReporter({ env, spawn: rec.spawn })
    reporter.sync(attached({ turnActive: 1 }))
    reporter.release()
    assert.deepEqual(rec.calls, [], `expected no calls for ${JSON.stringify(env)}`)
  }
})

test('a working turn reports once and repeats are suppressed', () => {
  const rec = recorder()
  const reporter = createHerdrReporter({ env: IN_HERDR, spawn: rec.spawn })
  const working = attached({ turnActive: 1 })

  // A streamed turn calls setState per frame; every one must not spawn.
  for (let i = 0; i < 50; i += 1) reporter.sync(working)

  assert.equal(rec.calls.length, 1)
  assert.deepEqual(argv(rec.calls, 0), [
    'pane', 'report-agent', 'w1:p1', ...SOURCE, '--state', 'working', '--seq', '1',
  ])
})

test('transitions report in order with an increasing sequence', () => {
  const rec = recorder()
  const reporter = createHerdrReporter({ env: IN_HERDR, spawn: rec.spawn })

  reporter.sync(attached())                                   // idle
  reporter.sync(attached({ turnActive: 1 }))                   // working
  reporter.sync(attached({ turnActive: 1, pendingApprovals: [{}] })) // blocked
  reporter.sync(attached())                                   // idle again

  assert.deepEqual(
    rec.calls.map((args) => [args[args.indexOf('--state') + 1], args[args.indexOf('--seq') + 1]]),
    [['idle', '1'], ['working', '2'], ['blocked', '3'], ['idle', '4']],
  )
})

test('a block carries the reason the sidebar shows', () => {
  const rec = recorder()
  const reporter = createHerdrReporter({ env: IN_HERDR, spawn: rec.spawn })

  reporter.sync(attached({ pendingApprovals: [{}] }))
  reporter.sync(attached())                                    // reset to idle
  reporter.sync(attached({ pendingApprovals: [{}, {}], pendingQuestions: [{}] }))

  assert.equal(flagValue(argv(rec.calls, 0), '--message'), '1 approval')
  assert.equal(flagValue(argv(rec.calls, 2), '--message'), '2 approvals, 1 question')
})

test('release hands authority back only after a report, and only once', () => {
  const rec = recorder()
  const reporter = createHerdrReporter({ env: IN_HERDR, spawn: rec.spawn })

  // Nothing was reported, so there is no authority to release.
  reporter.release()
  assert.deepEqual(rec.calls, [])

  reporter.sync(attached({ turnActive: 1 }))
  reporter.release()
  reporter.release()  // shutdown is idempotent upstream; release must match

  assert.deepEqual(argv(rec.calls, 1), [
    'pane', 'release-agent', 'w1:p1', ...SOURCE,
  ])
  assert.equal(rec.calls.length, 2)
})
