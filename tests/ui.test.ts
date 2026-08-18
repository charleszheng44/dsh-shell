/**
 * ui.ts tests: terminalSafeText() sanitization of DSH-derived content and
 * fixed-width fenced Markdown rendering through Pi.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Markdown, getCapabilities, setCapabilities } from '@earendil-works/pi-tui'

import { assistantMarkdown, headerText, neutralizeLinks, pickerLabel, sessionPickerItems, terminalSafeText } from '../src/ui.js'

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

test('fixed-width fenced Markdown renders through the dsh-tui assembly path without control chars', () => {
  // Exercise the real dsh-tui pipeline: assistantMarkdown assembles the row,
  // terminalSafeText sanitizes it, then Pi renders at a fixed width.
  const row = { kind: 'assistant', segments: [{ kind: 'text', text: '```ts\nconst answer = 42\n```' }] } as const
  const markdown = new Markdown(terminalSafeText(assistantMarkdown(row.segments)), 1, 0, markdownTheme as never)
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
  const out = neutralizeLinks('see [docs](https://evil.example/x) now')
  const readable = out.replace(/\u200B/g, '')
  assert.ok(!readable.includes('](https://evil.example/x)'))
  assert.ok(readable.includes('docs (https://evil.example/x)'))
  // The zero-width space is invisible when rendered but breaks autolinking.
  assert.ok(out.includes('\u200B'), 'URL must be broken with a zero-width space')

  const fenced = neutralizeLinks('```\n[code](https://x)\n```\nand [link](https://y)')
  assert.ok(fenced.includes('[code](https://x)'), 'code fence links stay code')
  assert.ok(!fenced.includes('and [link](https://y)'))

  assert.equal(neutralizeLinks('plain'), 'plain')
})

test('neutralizeLinks tracks fence parity exactly', () => {
  // A ```-fence containing a literal ~~~ line must not close the fence.
  const out = neutralizeLinks('```\n~~~ not a fence\n[code](https://x)\n```\n[link](https://y)')
  assert.ok(out.includes('[code](https://x)'))
  assert.ok(!out.includes('[link](https://y)'))
})

test('neutralizeLinks breaks cross-line labels, paren URLs, and reference pairs', () => {
  // [foo] with the destination on the next line: the label stays literal
  // and the URL is broken, so marked cannot form the link.
  const crossLine = neutralizeLinks('[foo]\n(https://evil.example/x)')
  assert.ok(crossLine.includes('[foo]'), 'label brackets stay untouched')
  assert.ok(!crossLine.includes('(https://evil.example/x)'), 'paren URL must be broken')
  assert.ok(crossLine.includes('\u200B'), 'URL must be broken with a zero-width space')
  // A bare URL in parentheses autolinks too; it must be broken as well.
  assert.ok(!neutralizeLinks('(https://evil.example/x)').includes('(https://'))
  // Adjacent parenthesized URLs are each broken, not swallowed by one match.
  const adjacent = neutralizeLinks('(https://a.com)(https://b.com)')
  assert.equal((adjacent.match(/\u200B/g) ?? []).length, 2)
  assert.ok(!adjacent.includes('(https://b.com)'))
  // Reference definitions and uses must not survive as link syntax.
  const ref = neutralizeLinks('[ref][1]\n[1]: https://evil.example/x')
  assert.ok(!ref.includes('https://evil.example'))
})

test('neutralizeLinks breaks URLs anywhere and covers ftp and loose emails', () => {
  // marked autolinks bare URLs with no boundary requirement: any preceding
  // character (colons, quotes, fullwidth parens) must not shelter the URL.
  for (const text of [
    'see:https://evil.example/x',
    '参考：https://evil.example/x',
    '"https://evil.example/x"',
    '（https://evil.example/x）',
    '【https://evil.example/x】',
    '>ftp://evil.example/x',
  ]) {
    const out = neutralizeLinks(text)
    assert.ok(out.includes('\u200B'), `URL not broken in ${JSON.stringify(text)}: ${out}`)
  }
  // ftp: is autolinked by marked and must be broken like http(s).
  assert.ok(!neutralizeLinks('ftp://evil.example/x').includes('ftp://evil'))
  // marked's email coverage is looser than a strict TLD rule.
  assert.ok(!neutralizeLinks('evil@example.c').includes('evil@example.c'))
  assert.ok(!neutralizeLinks('evil@exam_ple.com').includes('evil@exam_ple.com'))
})

test('neutralizeLinks leaves inline code spans untouched', () => {
  // marked renders code spans verbatim and code content cannot become a link.
  const out = neutralizeLinks('use `arr[0]` and [ok](https://x.com)')
  assert.ok(out.includes('`arr[0]`'), 'code-span brackets must not be escaped')
  assert.ok(out.includes('ok (h'), 'inline links outside code are still converted')
  assert.ok(!out.includes('](https://x.com)'))
  // URLs inside code spans are code, not links: nothing to break.
  const codeUrl = neutralizeLinks('see `https://x.com` now')
  assert.ok(!codeUrl.includes('\u200B'))
  assert.ok(codeUrl.includes('`https://x.com`'))
})

test('neutralizeLinks neutralizes text an unterminated code span would shelter', () => {
  // Unbalanced backticks: marked never closes the span, so the text is plain.
  const unclosed = neutralizeLinks('`unclosed https://evil.example/x')
  assert.ok(unclosed.includes('\u200B'), 'unterminated code text must be neutralized')
  const odd = neutralizeLinks('`a` ` b https://evil.example/x')
  assert.ok(odd.includes('\u200B'))
  // A backtick fence whose info string contains backticks is not a fence to
  // marked; the line must not be sheltered.
  const badFence = neutralizeLinks('```code``` and https://evil.example/x')
  assert.ok(badFence.includes('\u200B'), 'invalid fence opener must not shelter the URL')
})

test('assistantMarkdown neutralizes links before Pi renders them', () => {
  const out = assistantMarkdown([{ kind: 'text', text: 'click [here](https://evil.example)' }])
  assert.ok(!out.includes('](https://evil.example)'))
  const readable = out.replace(/\u200B/g, '')
  assert.ok(readable.includes('here (https://evil.example)'))
})

test('Pi renders no OSC 8 hyperlink for any DSH link form', () => {
  const original = getCapabilities()
  setCapabilities({ images: original.images, trueColor: original.trueColor, hyperlinks: true })
  try {
    const forms = [
      '[text](https://evil.example/x)',
      '![alt](https://evil.example/x.png)',
      '<https://evil.example/x>',
      'https://evil.example/x',
      'www.evil.example/x',
      'mailto:evil@example.com',
      '[titled](https://evil.example/x "title")',
      'multi [a](https://x) and [b](https://y)',
      '[a [b]](https://evil.example/x)',
      '[foo]\n(https://evil.example/x)',
      '[foo]\n(https://evil.example/x "title")',
      '(https://evil.example/x)',
      '(https://a.com)(https://b.com)',
      '[ref][1]\n[1]: https://evil.example/x',
      'see `https://evil.example/x` and `arr[0]` now',
      'see:https://evil.example/x',
      'ftp://evil.example/x',
      'evil@example.c',
      '`unclosed https://evil.example/x',
    ]
    for (const text of forms) {
      const markdown = new Markdown(terminalSafeText(assistantMarkdown([{ kind: 'text', text }])), 1, 0, markdownTheme as never)
      const rendered = markdown.render(80).join('\n')
      assert.ok(!rendered.includes('\x1b]8;'), `OSC 8 emitted for ${JSON.stringify(text)}: ${JSON.stringify(rendered)}`)
    }
  } finally {
    setCapabilities(original)
  }
})

test('tool markers cannot smuggle links into OSC 8', () => {
  const original = getCapabilities()
  setCapabilities({ images: original.images, trueColor: original.trueColor, hyperlinks: true })
  try {
    const markdown = new Markdown(
      terminalSafeText(assistantMarkdown([{ kind: 'tool', name: '[x](https://evil.example)' }])),
      1,
      0,
      markdownTheme as never,
    )
    const rendered = markdown.render(80).join('\n')
    assert.ok(!rendered.includes('\x1b]8;'), `OSC 8 emitted from tool marker: ${JSON.stringify(rendered)}`)
  } finally {
    setCapabilities(original)
  }
})

test('headerText shows project, session, connection, and the notice', () => {
  const state = {
    connection: 'connected',
    projects: [{ key: 'w1', title: 'proj' }],
    sessions: [],
    selectedProject: 'w1',
    attachment: { phase: 'none' },
    notice: 'Session no longer exists',
  } as never
  const text = headerText(state)
  assert.ok(text.includes('proj / no session / connected'))
  assert.ok(text.includes('Session no longer exists'))
})

test('sessionPickerItems renders a notice row for an empty project', () => {
  const items = sessionPickerItems([])
  assert.deepEqual(items, [{ value: '', label: 'No attachable sessions' }])
})

test('sessionPickerItems sanitizes titles with a fallback label', () => {
  const items = sessionPickerItems([{ sessionId: 's1' as never, title: '\x1b[31m\x1b[0m' }])
  assert.equal(items[0]?.value, 's1')
  assert.equal(items[0]?.label, 'Session')
})
