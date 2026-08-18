/**
 * ui.ts tests: terminalSafeText() sanitization of DSH-derived content and
 * fixed-width fenced Markdown rendering through Pi.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Markdown } from '@earendil-works/pi-tui'

import { assistantMarkdown, neutralizeLinks, pickerLabel, terminalSafeText } from '../src/ui.js'

const identity = (text: string): string => text
const markdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
} as const

test('normalizes CRLF and bare CR to LF', () => {
  assert.equal(terminalSafeText('a\r\nb\rc'), 'a\nb\nc')
})

test('strips CSI cursor and screen commands', () => {
  const input = 'before\x1b[2J\x1b[H\x1b[31mred\x1b[0mafter'
  const out = terminalSafeText(input)
  assert.ok(!out.includes('\x1b['))
  assert.equal(out, 'beforeredafter')
})

test('strips OSC title and clipboard sequences', () => {
  const title = 'hello\x1b]0;injected title\x07world'
  const out = terminalSafeText(title)
  // Whatever stripVTControlCharacters leaves of an OSC frame, no escape byte,
  // BEL, or other C0/C1 control may survive the display edge.
  assert.ok(!out.includes('\x1b'))
  assert.ok(!out.includes('\x07'))
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(out))

  const clipboard = 'copy\x1b]52;c;c2FmZQ==\x07me'
  const out2 = terminalSafeText(clipboard)
  assert.ok(!out2.includes('\x1b'))
  assert.ok(!out2.includes('\x07'))
})

test('removes BEL and backspace', () => {
  assert.equal(terminalSafeText('a\x07b\x08c'), 'abc')
})

test('removes C1 controls', () => {
  assert.equal(terminalSafeText('a\x9b1;2Hb\x9dc'), 'abc')
})

test('keeps LF, tab, and ordinary Unicode', () => {
  assert.equal(terminalSafeText('line1\tline2\n雪 ❄️ 😀'), 'line1\tline2\n雪 ❄️ 😀')
})

test('keeps fenced Markdown intact', () => {
  const input = 'before\n```ts\nconst x = 1\n```\nafter'
  assert.equal(terminalSafeText(input), input)
})

test('fixed-width fenced Markdown renders through Pi without control chars', () => {
  const markdown = new Markdown('```ts\nconst answer = 42\n```', 1, 0, markdownTheme as never)
  const lines = markdown.render(40)
  assert.ok(lines.length > 0)
  for (const line of lines) {
    assert.ok(!line.includes('\x1b['), `line must not contain escape sequences: ${JSON.stringify(line)}`)
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(line), `line must not contain controls: ${JSON.stringify(line)}`)
    assert.ok(line.length <= 40, `line fits the width: ${JSON.stringify(line)}`)
  }
  const joined = lines.join('\n')
  assert.match(joined, /const answer = 42/)
})

test('empty string stays empty', () => {
  assert.equal(terminalSafeText(''), '')
})

test('pickerLabel never falls back to a raw DSH value when the title sanitizes to empty', () => {
  assert.equal(pickerLabel('ok title', 'Workspace'), 'ok title')
  assert.equal(pickerLabel('\x1b[31m\x1b[0m', 'Session'), 'Session')
  assert.equal(pickerLabel('', 'All sessions'), 'All sessions')
})
test('neutralizeLinks strips hrefs from markdown links but keeps code fences', () => {
  assert.equal(
    neutralizeLinks('see [docs](https://evil.example/x) now'),
    'see docs (https://evil.example/x) now',
  )
  assert.equal(neutralizeLinks('```\n[code](https://x)\n```\nand [link](https://y)'),
    '```\n[code](https://x)\n```\nand link (https://y)')
  assert.equal(neutralizeLinks('plain'), 'plain')
})

test('assistantMarkdown neutralizes links before Pi renders them', () => {
  const out = assistantMarkdown([{ kind: 'text', text: 'click [here](https://evil.example)' }])
  assert.ok(!out.includes('](https://evil.example)'))
  assert.ok(out.includes('here (https://evil.example)'))
})
