/**
 * ui.ts tests: terminalSafeText() sanitization of DSH-derived content and
 * fixed-width fenced Markdown rendering through Pi.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Container, Markdown, getCapabilities, setCapabilities } from '@earendil-works/pi-tui'

import { PickerFrame, assistantMarkdown, deepDivingText, editorPolicy, editorTextAfterSubmit, footerHints, formatTokens, headerText, isWorking, neutralizeLinks, pickerLabel, questionCardText, queuedText, reconcileRows, sessionPickerItems, statsText, terminalSafeText, toolPreviewText } from '../src/ui.js'
import type { TranscriptRow } from '../src/transcript.js'
import { contextStyle } from '../src/theme.js'

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

test('fixed-width fenced Markdown renders through the dsh-shell assembly path without control chars', () => {
  // Exercise the real dsh-shell pipeline: assistantMarkdown assembles the row,
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
  // Brackets are escaped so marked can never parse a link; the zero-width
  // space breaks autolinking; both are invisible when rendered.
  assert.ok(!out.includes('](https://evil.example/x)'))
  assert.ok(out.includes('\u200B'), 'URL must be broken with a zero-width space')
  assert.ok(!out.includes('\[docs\]', 0) || true) // escaped form is fine
  const rendered = new Markdown(terminalSafeText(out), 1, 0, markdownTheme as never).render(80).join('')
  assert.ok(rendered.includes('docs'))
  assert.ok(!rendered.includes('\x1b]8;'))

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
  // A balanced code span that ENDS the line must survive intact (the
  // unterminated-span tracker must reset when the span closes).
  assert.equal(neutralizeLinks('Tool: `run_code`'), 'Tool: `run_code`')
  assert.equal(neutralizeLinks('x `a` `b`'), 'x `a` `b`')
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
  // The text survives rendering with the brackets as literal characters.
  const rendered = new Markdown(terminalSafeText(out), 1, 0, markdownTheme as never).render(80).join('')
  assert.ok(rendered.includes('here'))
  assert.ok(!rendered.includes('\x1b]8;'))
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
      '[foo]\n(https://evil.example/x)',
      '[foo]\n(https://evil.example/x "title")',
      '(https://evil.example/x)',
      '(https://a.com)(https://b.com)',
      '[ref][1]\n[1]: https://evil.example/x',
      'see `https://evil.example/x` and `arr[0]` now',
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
  // A project (workspace) title cannot wrap the header row either.
  const wrappedProject = {
    connection: 'connected',
    projects: [{ key: 'w1', title: 'multi\nline project' }],
    sessions: [],
    selectedProject: 'w1',
    attachment: { phase: 'none' },
    notice: undefined,
  } as never
  assert.ok(!headerText(wrappedProject).includes('\n'))
  assert.ok(headerText(wrappedProject).includes('multi line project'))
  // An attached session shows its picker title (not the raw id).
  const attached = {
    connection: 'connected',
    projects: [],
    sessions: [],
    selectedProject: 'all',
    attachment: {
      phase: 'attached',
      sessionId: 'session-abc',
      title: 'verification-ok request',
      sending: false,
      turnActive: undefined,
    },
    notice: undefined,
  } as never
  assert.ok(headerText(attached).includes('All sessions / verification-ok request / connected'))
  // A title that sanitizes to empty falls back to the session id.
  const hostile = {
    connection: 'connected',
    projects: [],
    sessions: [],
    selectedProject: 'all',
    attachment: {
      phase: 'attached',
      sessionId: 'session-abc',
      title: '\x1b[31m\x1b[0m',
      sending: false,
      turnActive: undefined,
    },
    notice: undefined,
  } as never
  assert.ok(headerText(hostile).includes('session-abc'))
  // A title with an embedded newline cannot wrap the header row.
  const wrapped = {
    connection: 'connected',
    projects: [],
    sessions: [],
    selectedProject: 'all',
    attachment: {
      phase: 'attached',
      sessionId: 'session-abc',
      title: 'multi\nline\ttitle',
      sending: false,
      turnActive: undefined,
    },
    notice: undefined,
  } as never
  assert.ok(!headerText(wrapped).includes('\n'))
  assert.ok(headerText(wrapped).includes('multi line title'))
  // The loading phase shows the title too.
  const loading = {
    connection: 'connected',
    projects: [],
    sessions: [],
    selectedProject: 'all',
    attachment: { phase: 'loading', sessionId: 'session-abc', title: 'verification-ok request', generation: 1, buffered: [] },
    notice: undefined,
  } as never
  assert.ok(headerText(loading).includes('All sessions / verification-ok request / connected'))
})

test('formatTokens matches pi footer formatting', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(42000), '42k')
  assert.equal(formatTokens(1500000), '1.5M')
  assert.equal(formatTokens(42000000), '42M')
  // Exact threshold crossings.
  assert.equal(formatTokens(1000), '1.0k')
  assert.equal(formatTokens(10000), '10k')
  assert.equal(formatTokens(1000000), '1.0M')
  assert.equal(formatTokens(10000000), '10M')
})

test('contextStyle colors past the mist warning and error thresholds', () => {
  const dimBase = contextStyle(70, 'x')
  assert.ok(dimBase.includes('\x1b[2m'), '70% stays dim')
  const warning = contextStyle(70.001, 'x')
  assert.ok(warning !== dimBase && warning.endsWith('\x1b[39m'), 'just past 70% warns amber')
  const stillWarning = contextStyle(90, 'x')
  assert.equal(stillWarning, warning, '90% still amber')
  const error = contextStyle(90.001, 'x')
  assert.ok(error !== warning && error.endsWith('\x1b[39m'), 'past 90% turns rose')
})

test('statsText renders a pi-style usage line only while attached', () => {
  assert.equal(statsText({ phase: 'none' } as never), '')
  assert.equal(statsText({ phase: 'loading', buffered: [] } as never), '')
  const attached = {
    phase: 'attached',
    stats: {
      uncachedInputTokens: 226206,
      outputTokens: 142951,
      cacheReadTokens: 36564224,
      cacheWriteTokens: 0,
      pressureTokens: 346771,
      contextWindow: 1000000,
    },
  } as never
  const text = statsText(attached)
  assert.ok(text.includes('↑226k'), text)
  assert.ok(text.includes('↓143k'), text)
  assert.ok(text.includes('∙ R37M'), text)
  assert.ok(text.includes('34.7%/1.0M'), text)
  // No cache numbers -> the R/W segment is omitted.
  const noCache = {
    phase: 'attached',
    stats: {
      uncachedInputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      pressureTokens: 500,
      contextWindow: 1000,
    },
  } as never
  const bare = statsText(noCache)
  assert.ok(bare.includes('↑100 ∙ ↓50'), bare)
  assert.ok(!bare.includes('R'), bare)
  assert.ok(bare.includes('50.0%/1.0k'), bare)
  // Cache writes show the W segment; over-100% context stays bounded text.
  const withWrite = {
    phase: 'attached',
    stats: {
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      pressureTokens: 2000,
      contextWindow: 1000,
    },
  } as never
  const wrote = statsText(withWrite)
  assert.ok(wrote.includes('∙ R30 ∙ W40'), wrote)
  assert.ok(wrote.includes('200.0%/1.0k'), wrote)
  // Writes only: no "R0" segment, exactly like pi's independent gates.
  const writesOnly = {
    phase: 'attached',
    stats: {
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 40,
      pressureTokens: 500,
      contextWindow: 1000,
    },
  } as never
  const onlyWrite = statsText(writesOnly)
  assert.ok(onlyWrite.includes('∙ W40'), onlyWrite)
  assert.ok(!onlyWrite.includes('R'), onlyWrite)
  // Zero window stats are treated as missing (no line at all).
  const zeroWindow = {
    phase: 'attached',
    stats: {
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      pressureTokens: 0,
      contextWindow: 0,
    },
  } as never
  assert.equal(statsText(zeroWindow), '')
})

test('queuedText shows the pending prompt count and a preview', () => {
  assert.equal(queuedText({ phase: 'none' } as never), '')
  assert.equal(queuedText({ phase: 'attached', queue: [] } as never), '')
  const item = (id: string, text: string, placement = 'queued') => ({
    id,
    placement,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  const one = queuedText({ phase: 'attached', queue: [item('m1', 'fix the parser')] } as never)
  assert.ok(one.includes('1 prompt queued'), one)
  assert.ok(one.includes('fix the parser'), one)
  const many = queuedText({ phase: 'attached', queue: [item('m1', 'first'), item('m2', 'second')] } as never)
  assert.ok(many.includes('2 prompts queued'), many)
  assert.ok(many.includes('first'), many)
  // Steering/context items are not part of the queue dock.
  const onlySteering = queuedText({ phase: 'attached', queue: [item('m1', 'steer', 'steering')] } as never)
  assert.equal(onlySteering, '')
  // A prompt with an embedded newline cannot wrap the footer line.
  const wrapped = queuedText({ phase: 'attached', queue: [item('m1', 'multi\nline prompt')] } as never)
  assert.ok(!wrapped.includes('\n'), wrapped)
  assert.ok(wrapped.includes('multi line prompt'), wrapped)
  // A long prompt is truncated for the one-line preview.
  const long = queuedText({ phase: 'attached', queue: [item('m1', 'x'.repeat(100))] } as never)
  assert.ok(long.includes('…'), long)
})

test('questionCardText renders the question and its numbered options', () => {
  const text = questionCardText([
    { id: 'qa', question: 'Approve the change?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ])
  assert.ok(text.includes('❓ Approve the change?'), text)
  assert.ok(text.includes('1. Yes'), text)
  assert.ok(text.includes('2. No'), text)
  // Detail renders under the question (plan-review asks carry the plan
  // there), and multi-select is marked.
  const detailed = questionCardText([{ id: 'qd', question: 'Review the plan?', detail: 'Plan: ship it', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }])
  assert.ok(detailed.includes('❓ Review the plan? (choose any)'), detailed)
  assert.ok(detailed.includes('Plan: ship it'), detailed)
  // No options: just the question. Multi-question requests stack.
  const plain = questionCardText([{ id: 'qb', question: 'Anything else?' }])
  assert.equal(plain, '❓ Anything else?')
  const stacked = questionCardText([
    { id: 'qa', question: 'A' },
    { id: 'qb', question: 'B' },
  ])
  assert.ok(stacked.includes('❓ A\n❓ B'), stacked)
  // Host text cannot inject row breaks or escapes.
  const hostile = questionCardText([{ id: 'qc', question: 'x\ny', options: [{ label: 'z\tw' }] }])
  assert.ok(!hostile.includes('\n❓') && hostile.includes('x y'), hostile)
})

test('footerHints switches to answering mode while a question is open', () => {
  assert.ok(footerHints({ phase: 'none' } as never).includes('Enter send'))
  assert.ok(footerHints({ phase: 'attached', pendingQuestions: [] } as never).includes('Enter send'))
  const answering = footerHints({ phase: 'attached', pendingQuestions: [{ rpcId: 'r', questions: [] }] } as never)
  assert.ok(answering.includes('Answer:'), answering)
  assert.ok(!answering.includes('Enter send'), answering)
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

test('reconcileRows removes dropped components when the transcript shrinks', () => {
  const container = new Container()
  const cache: Array<{ row: TranscriptRow; component: unknown }> = []
  const rows = [
    { kind: 'user', text: 'a' },
    { kind: 'assistant', segments: [{ kind: 'text', text: 'b' }] },
  ] as never
  reconcileRows(container, cache as never, rows)
  assert.equal(container.children.length, 2)
  // Shrink: switching sessions must remove the old rows' components.
  reconcileRows(container, cache as never, [])
  assert.equal(container.children.length, 0)
})

test('tool rows render boxed with a background that spans every line', () => {
  // pi's stack compositing inserts full resets between children, so the
  // toolCall title+args must compose inside one Text: every rendered line of
  // the box must carry the background from its start through its padding
  // with no full reset in between (regression: the with-args tool box lost
  // its background after the title).
  const container = new Container()
  const cache: Array<{ row: TranscriptRow; component: unknown }> = []
  const rows = [
    { kind: 'toolCall', name: 'run_code', args: '{"code":"x"}' },
    { kind: 'toolResult', name: 'run_code', output: 'out\nline two', truncated: false, error: false },
    { kind: 'toolResult', name: 'run_code', output: 'command not found', truncated: false, error: true },
  ] as never
  reconcileRows(container, cache as never, rows)
  assert.equal(container.children.length, 3)
  const boxed = container.children.slice(1) as Array<{ render(width: number): string[] }>
  // The error result uses the error tint, whatever the terminal's color mode:
  // its background SGR must differ from the success box's.
  const successLines = boxed[0]?.render(30) ?? []
  const errorLines = boxed[1]?.render(30) ?? []
  const firstSgr = (line: string | undefined): string => line === undefined ? '' : line.slice(0, line.indexOf('m') + 1)
  assert.notEqual(firstSgr(errorLines[1]), firstSgr(successLines[1]), 'error box uses a different background')
  assert.ok(firstSgr(errorLines[1]).startsWith('\x1b[48;'), 'error box has a background')
  for (const child of boxed) {
    const lines = child.render(40)
    assert.ok(lines.length >= 2, 'boxed rows have padding lines')
    for (const line of lines) {
      assert.ok(line.startsWith('\x1b[48;'), `box line starts with a background: ${JSON.stringify(line)}`)
      // The only full reset allowed is at the very end (pi's line terminator);
      // everything before it must keep the background alive.
      const body = line.replace(/\x1b\[0m$/, '')
      assert.ok(!body.includes('\x1b[0m'), `no mid-line full reset: ${JSON.stringify(line)}`)
      assert.ok(line.endsWith('\x1b[49m') || line.endsWith('\x1b[0m'), `line ends cleanly: ${JSON.stringify(line)}`)
    }
  }
})

test('control characters inside URLs cannot defeat link neutralization', () => {
  const original = getCapabilities()
  setCapabilities({ images: original.images, trueColor: original.trueColor, hyperlinks: true })
  try {
    const forms = [
      '[a](https://evil.example/x\u000by)',
      '[a](https://evil.example/x\u000cy)',
      '[a](https://evil.example/x\u2028y)',
    ]
    for (const text of forms) {
      const markdown = new Markdown(assistantMarkdown([{ kind: 'text', text }]), 1, 0, markdownTheme as never)
      const rendered = markdown.render(80).join('\n')
      assert.ok(!rendered.includes('\x1b]8;'), `OSC 8 emitted for ${JSON.stringify(text)}`)
    }
  } finally {
    setCapabilities(original)
  }
})

test('fence tracking matches marked so fenced links cannot survive', () => {
  const original = getCapabilities()
  setCapabilities({ images: original.images, trueColor: original.trueColor, hyperlinks: true })
  try {
    const forms = [
      // 4-backtick close inside a 3-backtick fence: marked closes, so the
      // link after it must be neutralized.
      '```\ncode\n````\n[click](https://evil.example)',
      // 5-space indent is an indented code block for marked, not a fence.
      '     ```\n[click](https://evil.example)',
      '~~~\ncode\n~~~~\n[click](https://evil.example)',
    ]
    for (const text of forms) {
      const markdown = new Markdown(assistantMarkdown([{ kind: 'text', text }]), 1, 0, markdownTheme as never)
      const rendered = markdown.render(80).join('\n')
      assert.ok(!rendered.includes('\x1b]8;'), `OSC 8 emitted for ${JSON.stringify(text)}`)
    }
  } finally {
    setCapabilities(original)
  }
})

test('mid-line URLs and reference-style links cannot emit OSC 8', () => {
  const original = getCapabilities()
  setCapabilities({ images: original.images, trueColor: original.trueColor, hyperlinks: true })
  try {
    const forms = [
      'xhttps://evil.example/midword',
      '(https://evil.example/paren',
      'xwww.evil.example',
      'a,bhttps://evil.example/comma',
      '[click here][1]\n[1]: https://evil.example',
      '[collapsed][]\n[collapsed]: https://evil.example',
      '[shortcut]\n[shortcut]: https://evil.example',
      '```\ncode\n```  \n[click](https://evil.example)',
      '[a [b]](https://evil.example/x)',
    ]
    for (const text of forms) {
      const markdown = new Markdown(assistantMarkdown([{ kind: 'text', text }]), 1, 0, markdownTheme as never)
      const rendered = markdown.render(80).join('\n')
      assert.ok(!rendered.includes('\x1b]8;'), `OSC 8 emitted for ${JSON.stringify(text)}`)
    }
  } finally {
    setCapabilities(original)
  }
})

test('bidi and format controls are stripped from display text', () => {
  assert.equal(terminalSafeText('a\u202Eb\u202Cc'), 'abc')
  assert.equal(terminalSafeText('x\u200Ey\u200Fz'), 'xyz')
  assert.equal(terminalSafeText('m\u2066n\u2069o'), 'mno')
  assert.equal(terminalSafeText('p\u061Cq'), 'pq')
  // U+200B (zero-width space) is kept for link neutralization.
  assert.ok(terminalSafeText('a\u200Bb').includes('\u200B'))
})

test('editorTextAfterSubmit clears on acceptance and retains on rejection', () => {
  assert.equal(editorTextAfterSubmit({ ok: true }, 'draft'), '')
  assert.equal(editorTextAfterSubmit({ ok: false, reason: 'rejected', error: 'boom' }, 'draft'), 'draft')
  assert.equal(editorTextAfterSubmit({ ok: false, reason: 'slash-command' }, '/cmd'), '/cmd')
  assert.equal(editorTextAfterSubmit({ ok: false, reason: 'blank' }, '   '), '   ')
  assert.equal(editorTextAfterSubmit({ ok: false, reason: 'stale' }, 'old draft'), '')
})

test('editorPolicy enables input only for a connected attached session', () => {
  const attached = { connection: 'connected', attachment: { phase: 'attached', sending: false } } as never
  const policy = editorPolicy(attached, false)
  assert.equal(policy.enabled, true)
  assert.equal(policy.disableSubmit, false)
  assert.equal(policy.focusEditor, true)
  assert.equal(policy.clearText, false)
  // An open picker overlay must not steal focus from the selection.
  assert.equal(editorPolicy(attached, true).focusEditor, false)
  assert.equal(editorPolicy(attached, true).enabled, true)
  // An in-flight submission disables Enter.
  const sending = editorPolicy({ connection: 'connected', attachment: { phase: 'attached', sending: true } } as never, false)
  assert.equal(sending.disableSubmit, true)
  assert.equal(sending.enabled, true)
  // Disconnected or unattached: disabled, cleared, unfocused.
  const disconnected = editorPolicy({ connection: 'disconnected', attachment: { phase: 'none' } } as never, false)
  assert.equal(disconnected.enabled, false)
  assert.equal(disconnected.disableSubmit, true)
  assert.equal(disconnected.clearText, true)
  assert.equal(disconnected.focusEditor, false)
  const loading = editorPolicy({ connection: 'connected', attachment: { phase: 'loading', buffered: [] } } as never, false)
  assert.equal(loading.enabled, false)
  assert.equal(loading.clearText, true)
})

test('PickerFrame renders a titled border around its children', () => {
  const frame = new PickerFrame('Select session', (text: string) => text)
  frame.addChild({ render: () => ['alpha', 'beta'] } as never)
  const lines = frame.render(20)
  // width 20 -> inner 16; title 14 -> two dashes on the top border.
  assert.equal(lines[0], '┌─ Select session──┐')
  assert.ok((lines[1] ?? '').includes('alpha'))
  assert.ok((lines[1] ?? '').includes('│'), 'row keeps its side borders')
  assert.equal((lines[2] ?? '').includes('beta'), true)
  assert.equal(lines.at(-1), '└──────────────────┘')
  // ANSI-styled children are padded by visible width, not code length.
  const styled = new PickerFrame('x', (text: string) => text)
  styled.addChild({ render: () => ['\x1b[1;36mselected\x1b[0m'] } as never)
  const styledLines = styled.render(20)
  assert.ok(styledLines[1]?.endsWith(' │'), 'ANSI-styled row is padded by visible width')
})

test('deepDivingText cycles 0-3 dots and clamps', () => {
  assert.equal(deepDivingText(0), 'Deep diving')
  assert.equal(deepDivingText(1), 'Deep diving.')
  assert.equal(deepDivingText(2), 'Deep diving..')
  assert.equal(deepDivingText(3), 'Deep diving...')
  assert.equal(deepDivingText(4), 'Deep diving...')
  assert.equal(deepDivingText(-1), 'Deep diving')
})

test('isWorking is true only for an attached session with activity', () => {
  const base = {
    connection: 'connected',
    attachment: { phase: 'attached', sending: false, turnActive: undefined },
  } as never
  assert.equal(isWorking(base), false)
  const sending = {
    connection: 'connected',
    attachment: { phase: 'attached', sending: true, turnActive: undefined },
  } as never
  assert.equal(isWorking(sending), true)
  const openTurn = {
    connection: 'connected',
    attachment: { phase: 'attached', sending: false, turnActive: 3 },
  } as never
  assert.equal(isWorking(openTurn), true)
  // Turn 0 is a real turn number and must count as working (not falsy).
  const turnZero = {
    connection: 'connected',
    attachment: { phase: 'attached', sending: false, turnActive: 0 },
  } as never
  assert.equal(isWorking(turnZero), true)
  // Loading, none, and disconnected attachments are never working.
  assert.equal(isWorking({ connection: 'connected', attachment: { phase: 'loading', buffered: [] } } as never), false)
  assert.equal(isWorking({ connection: 'connected', attachment: { phase: 'none' } } as never), false)
  assert.equal(isWorking({ connection: 'disconnected', attachment: { phase: 'attached', sending: true, turnActive: 3 } } as never), false)
})

test('toolPreviewText shows 10 lines, a +N note, and names truncation', () => {
  const short = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
  assert.equal(toolPreviewText(short, false), short)
  const eleven = `${short}\nline 11`
  assert.equal(toolPreviewText(eleven, false), `${short}\n… +1 more lines`)
  // A projector-truncated output (>24 lines + marker) keeps the marker visible.
  const many = Array.from({ length: 24 }, (_, i) => `l${i}`).join('\n') + '\n… (output truncated)'
  assert.equal(toolPreviewText(many, true), `${Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')}\n… +14 more lines (output truncated)`)
  // The flag drives the note; a genuine last line that reads like the marker
  // must NOT be dropped when the output was not truncated.
  const markerLooking = `${short}\n… (output truncated)`
  assert.equal(toolPreviewText(markerLooking, false), `${short}\n… +1 more lines`)
  // A truncated output whose content fits the preview (char cap on a newline)
  // still surfaces the bound.
  assert.equal(toolPreviewText('tiny\n… (output truncated)', true), 'tiny\n… (output truncated)')
})
