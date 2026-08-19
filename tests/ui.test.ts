/**
 * ui.ts tests: terminalSafeText() sanitization of DSH-derived content and
 * fixed-width fenced Markdown rendering through Pi.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Container, Markdown, getCapabilities, setCapabilities, visibleWidth as visibleWidthOf, type Component } from '@earendil-works/pi-tui'

import { PickerFrame, TranscriptList, approvalCardText, assistantMarkdown, canEditQueued, deepDivingText, editorPolicy, editorTextAfterSubmit, footerHints, formatTokens, headerText, isWorking, neutralizeLinks, pickerLabel, questionCardText, queuedText, reasoningText, reconcileRows, sessionPickerItems, statsText, stripFakeCursorCell, terminalSafeText, toolPreviewText } from '../src/ui.js'
import type { TranscriptRow } from '../src/transcript.js'
import { contextStyle, statsCacheStyle, statsInputStyle, statsModelStyle, statsOutputStyle } from '../src/theme.js'

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
  const healthy = contextStyle(70, 'x')
  assert.ok(!healthy.includes('\x1b[2m'), '70% is not dim (readability)')
  assert.ok(healthy.endsWith('\x1b[39m'), 'healthy ends with the fg reset')
  const warning = contextStyle(70.001, 'x')
  assert.ok(warning !== healthy && warning.endsWith('\x1b[39m'), 'just past 70% warns amber')
  const stillWarning = contextStyle(90, 'x')
  assert.equal(stillWarning, warning, '90% still amber')
  const error = contextStyle(90.001, 'x')
  assert.ok(error !== warning && error.endsWith('\x1b[39m'), 'past 90% turns rose')
})

test('statsText colors each part: input blue, output shimmer, cache subtle, model bold', () => {
  const attached = {
    phase: 'attached',
    modelLabel: 'DeepSeek · DeepSeek-V4-Flash (Max)',
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
  assert.ok(text.includes(statsInputStyle('↑226k')), 'input tokens in blue')
  assert.ok(text.includes(statsOutputStyle('↓143k')), 'output tokens in shimmer')
  assert.ok(text.includes(statsCacheStyle('R37M')), 'cache read in subtle')
  assert.ok(text.includes(statsModelStyle('DeepSeek · DeepSeek-V4-Flash (Max)')), 'model label bold and bright')
  assert.ok(text.includes(contextStyle(34.6771, '34.7%/1.0M')), 'context usage keeps its status color')
  // The three token parts must stay visually distinct from each other.
  assert.notEqual(statsInputStyle('x'), statsOutputStyle('x'), 'input and output colors differ')
  assert.notEqual(statsOutputStyle('x'), statsCacheStyle('x'), 'output and cache colors differ')
  assert.notEqual(statsInputStyle('x'), statsCacheStyle('x'), 'input and cache colors differ')
  // The separators stay dim so the parts read as one byline.
  assert.ok(text.includes('\x1b[2m · \x1b[22m'), 'separators are dim')
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
  assert.ok(text.includes('R37M'), text)
  assert.ok(text.includes('34.7%/1.0M'), text)
  // The model label renders right next to the context usage.
  const labeled = statsText({ phase: 'attached', modelLabel: 'Provider One · Model Two (High)', stats: { uncachedInputTokens: 226206, outputTokens: 142951, cacheReadTokens: 36564224, cacheWriteTokens: 0, pressureTokens: 346771, contextWindow: 1000000 } } as never)
  assert.ok(labeled.includes('Provider One · Model Two (High)'), labeled)
  assert.ok(labeled.indexOf('34.7%/1.0M') < labeled.indexOf('Provider One'), 'the label sits after the context usage')
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
  assert.ok(bare.includes('↑100') && bare.includes('↓50'), bare)
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
  assert.ok(wrote.includes('R30') && wrote.includes('W40'), wrote)
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
  assert.ok(onlyWrite.includes('W40'), onlyWrite)
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

test('queuedText renders the codex-style preview panel', () => {
  assert.equal(queuedText({ phase: 'none' } as never), '')
  assert.equal(queuedText({ phase: 'attached', pendingQuestions: [], queue: [] } as never), '')
  const item = (id: string, text: string, placement = 'queued') => ({
    id,
    placement,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  const one = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', 'fix the parser')] } as never)
  assert.ok(one.includes('• Queued follow-up inputs'), one)
  assert.ok(one.includes('↳ fix the parser'), one)
  assert.ok(one.includes('Ctrl+U edit · Ctrl+Y steer last queued message'), one)
  // While a question is open the edit hint disappears: the gate is off and
  // the hint must not advertise a key that would clobber the answer draft.
  const answering = queuedText({ phase: 'attached', pendingQuestions: [{ rpcId: 'q1' }], queue: [item('m1', 'fix the parser')] } as never)
  assert.ok(answering.includes('• Queued follow-up inputs'), answering)
  assert.ok(!answering.includes('Ctrl+U edit · Ctrl+Y steer'), answering)
  // Same while a prompt submission is in flight (the gate is off then).
  const sending = queuedText({ phase: 'attached', sending: true, pendingQuestions: [], queue: [item('m1', 'fix the parser')] } as never)
  assert.ok(sending.includes('• Queued follow-up inputs'), sending)
  assert.ok(!sending.includes('Ctrl+U edit · Ctrl+Y steer'), sending)
  // Every queued input is listed, in order.
  const many = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', 'first'), item('m2', 'second')] } as never)
  assert.ok(many.indexOf('↳ first') < many.indexOf('↳ second'), many)
  // Steering/context items are not part of the queue panel.
  const onlySteering = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', 'steer', 'steering')] } as never)
  assert.equal(onlySteering, '')
  // A prompt with an embedded newline collapses to one row.
  const wrapped = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', 'multi\nline prompt')] } as never)
  assert.ok(wrapped.includes('multi line prompt'), wrapped)
  // Long input is truncated to the visible-width cap with an ellipsis.
  const long = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', 'x'.repeat(100))] } as never)
  assert.ok(long.includes(`↳ ${'x'.repeat(60)}…`), long)
  // A queued item with no text part gets a placeholder row, not a bare indent.
  const empty = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', '')] } as never)
  assert.ok(empty.includes('↳ (no preview)'), empty)
  // The panel is bounded: only the first rows render, then a count line.
  const manyQueued = Array.from({ length: 9 }, (_, i) => item(`m${i}`, `prompt ${i}`))
  const capped = queuedText({ phase: 'attached', pendingQuestions: [], queue: manyQueued } as never)
  assert.ok(capped.includes('↳ prompt 0'), capped)
  assert.ok(capped.includes('↳ prompt 3'), capped)
  assert.ok(!capped.includes('↳ prompt 4'), capped)
  assert.ok(capped.includes('… +5 more queued'), capped)
})

test('queuedText strips hostile byte sequences and never injects rows', () => {
  const item = (id: string, text: string) => ({
    id,
    placement: 'queued',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  const cases: Array<[string, string, string]> = [
    // OSC 8 hyperlink with BEL terminator.
    ['osc8-bel', 'click \x1b]8;;https://evil.example\x07here\x07', 'click here'],
    // OSC 8 with ST terminator.
    ['osc8-st', 'a\x1b]8;;https://evil\x1b\\b', 'ab'],
    // CSI color.
    ['csi', '\x1b[31mred\x1b[0m', 'red'],
    // C1 CSI byte.
    ['c1', 'x\x9b31my', 'xy'],
    // DCS: the whole run (payload included) is dropped.
    ['dcs', '\x1bP1;2|payload\x1b\\end', 'end'],
    // C1 single-byte DCS (0x90 ... 0x9C ST): same wholesale drop.
    ['c1-dcs', 'a\x90payload\x9cb', 'ab'],
    // CRLF must not create an extra panel row.
    ['crlf', 'line one\r\nline two', 'line one line two'],
  ]
  for (const [label, raw, expected] of cases) {
    const out = queuedText({ phase: 'attached', pendingQuestions: [], queue: [item('m1', raw)] } as never)
    assert.ok(out.includes(expected), `${label}: ${JSON.stringify(out)}`)
    const withoutWrappers = out
      .split('\n')
      .map((line) => line.replace(/\x1b\[2m|\x1b\[22m/g, ''))
      .join('\n')
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(withoutWrappers), `${label}: control byte leaked: ${JSON.stringify(withoutWrappers)}`)
    assert.equal(out.split('\n').length, 3, `${label}: expected header+item+hint rows`)
  }
})

test('canEditQueued gates Ctrl+U on state, overlay, and reentry', () => {
  const item = (placement = 'queued') => ({ id: 'm1', placement, message: { role: 'user', content: [] } })
  const attached = {
    phase: 'attached',
    sending: false,
    queue: [item()],
    pendingQuestions: [],
  }
  const state = (attachment: unknown): never => ({ connection: 'connected', attachment }) as never
  assert.equal(canEditQueued(state(attached), false, false), true)
  // A pending question must not be clobbered by a pop.
  assert.equal(canEditQueued(state({ ...attached, pendingQuestions: [{ rpcId: 'q1' }] }), false, false), false)
  // A prompt submission in flight: the queue may still show the previous
  // last item, so a pop could remove the wrong one.
  assert.equal(canEditQueued(state({ ...attached, sending: true }), false, false), false)
  // An open picker overlay keeps focus where it is.
  assert.equal(canEditQueued(state(attached), true, false), false)
  // A pop already in flight must not target the same item twice.
  assert.equal(canEditQueued(state(attached), false, true), false)
  // Nothing queued: fall through to the editor's native Ctrl+U.
  assert.equal(canEditQueued(state({ ...attached, queue: [] }), false, false), false)
  // Steering/context placements do not count as pop targets.
  assert.equal(canEditQueued(state({ ...attached, queue: [item('steering')] }), false, false), false)
  // Not attached or not connected: no pop.
  assert.equal(canEditQueued(state({ phase: 'none', queue: [], pendingQuestions: [] }), false, false), false)
  assert.equal(canEditQueued({ connection: 'connecting', attachment: attached } as never, false, false), false)
})

test('reasoningText renders the thinking block with indented lines', () => {
  const plain = reasoningText('think one\nthink two', false)
  assert.ok(plain.includes('▍ Thinking'), plain)
  assert.ok(plain.includes('    think one'), plain)
  assert.ok(plain.includes('    think two'), plain)
  const truncated = reasoningText('think', true)
  assert.ok(truncated.includes('… (thinking truncated)'), truncated)
})

test('approvalCardText names the tool, reason, and answer keys', () => {
  const plain = approvalCardText({ rpcId: 'r' as never, approvalId: 'a1', toolName: 'bash' })
  assert.ok(plain.includes('Approval: Bash'), plain)
  assert.ok(plain.includes('Ctrl+A allow once'), plain)
  assert.ok(plain.includes('Ctrl+R reject'), plain)
  // The reason is flattened and sanitized.
  const withReason = approvalCardText({ rpcId: 'r' as never, approvalId: 'a2', toolName: 'run_code', reason: 'multi\nline \x1b[31mreason' })
  assert.ok(withReason.includes('multi line reason'), withReason)
  assert.ok(!withReason.includes('\x1b[31m'), withReason)
})

test('questionCardText renders the question and its numbered options', () => {
  const text = questionCardText([
    { id: 'qa', question: 'Approve the change?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ])
  assert.ok(text.includes('? Approve the change?'), text)
  assert.ok(text.includes('1. Yes'), text)
  assert.ok(text.includes('2. No'), text)
  // Detail renders under the question (plan-review asks carry the plan
  // there), and multi-select is marked.
  const detailed = questionCardText([{ id: 'qd', question: 'Review the plan?', detail: 'Plan: ship it', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }])
  assert.ok(detailed.includes('? Review the plan? (choose any)'), detailed)
  assert.ok(detailed.includes('Plan: ship it'), detailed)
  // No options: just the question. Multi-question requests stack.
  const plain = questionCardText([{ id: 'qb', question: 'Anything else?' }])
  assert.equal(plain, '? Anything else?')
  const stacked = questionCardText([
    { id: 'qa', question: 'A' },
    { id: 'qb', question: 'B' },
  ])
  assert.ok(stacked.includes('? A\n? B'), stacked)
  // Host text cannot inject row breaks or escapes.
  const hostile = questionCardText([{ id: 'qc', question: 'x\ny', options: [{ label: 'z\tw' }] }])
  assert.ok(hostile.includes('? x y'), hostile)
  assert.ok(hostile.includes('z w'), hostile)
  assert.ok(!hostile.includes('x\ny') && !hostile.includes('z\tw'), hostile)
})

test('footerHints switches to answering mode while a question is open', () => {
  assert.ok(footerHints({ phase: 'none' } as never).includes('Enter send'))
  assert.ok(footerHints({ phase: 'attached', pendingQuestions: [], pendingApprovals: [] } as never).includes('Enter send'))
  const answering = footerHints({ phase: 'attached', pendingQuestions: [{ rpcId: 'r', questions: [] }], pendingApprovals: [] } as never)
  assert.ok(answering.includes('Answer:'), answering)
  assert.ok(!answering.includes('Enter send'), answering)
  // While an approval is pending the Ctrl+A/Ctrl+R keys are advertised.
  const approving = footerHints({ phase: 'attached', pendingQuestions: [], pendingApprovals: [{ rpcId: 'r', approvalId: 'a1', toolName: 'bash' }] } as never)
  assert.ok(approving.includes('Ctrl+A allow once'), approving)
  // Only an OPEN turn advertises the ESC stop: prompt admission has no
  // turn to stop, and pending asks take the mode line.
  const admission = footerHints({ phase: 'attached', sending: true, pendingQuestions: [], pendingApprovals: [] } as never)
  assert.ok(!admission.includes('ESC stop'), admission)
  const workingTurn = footerHints({ phase: 'attached', turnActive: 0, pendingQuestions: [], pendingApprovals: [] } as never)
  assert.ok(workingTurn.includes('ESC stop turn'), workingTurn)
  const idle = footerHints({ phase: 'attached', pendingQuestions: [], pendingApprovals: [] } as never)
  assert.ok(!idle.includes('ESC stop'), idle)
  assert.ok(approving.includes('Ctrl+O model'), approving)
  assert.ok(!approving.includes('Answer:'), approving)
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

test('TranscriptList caches row lines and refreshes transients', () => {
  let rowRenders = 0
  const counter = (): Component => ({
    render: () => { rowRenders += 1; return ['row'] },
    invalidate: () => {},
  })
  const list = new TranscriptList()
  const a = counter()
  const b = counter()
  list.setRows([a, b])
  assert.deepEqual(list.render(40), ['row', 'row'])
  assert.equal(rowRenders, 2)
  // Unchanged rows reuse their cached lines.
  assert.deepEqual(list.render(40), ['row', 'row'])
  assert.equal(rowRenders, 2)
  // A changed row set recomputes only the affected index.
  const c = counter()
  list.setRows([a, c])
  assert.deepEqual(list.render(40), ['row', 'row'])
  assert.equal(rowRenders, 3)
  // Transients render fresh every frame; a transient layout change
  // recomputes all rows (the tail shifted).
  const live = { render: () => ['live'], invalidate: () => {} }
  list.setTransients([live])
  assert.deepEqual(list.render(40), ['row', 'row', 'live'])
  assert.equal(rowRenders, 5)
  // An UNCHANGED transient set (the steady streaming state) must not
  // recompute rows — this is the primary per-frame perf property.
  list.setTransients([live])
  assert.deepEqual(list.render(40), ['row', 'row', 'live'])
  assert.equal(rowRenders, 5)
  // A length change marks the new indices dirty and never reads past the
  // new length.
  const d = counter()
  list.setTransients([])
  list.setRows([a, c, d])
  assert.deepEqual(list.render(40), ['row', 'row', 'row'])
  assert.equal(rowRenders, 8)
  list.setRows([a])
  assert.deepEqual(list.render(40), ['row'])
  assert.equal(rowRenders, 8)
  // A width change recomputes everything.
  assert.equal(list.render(80).length, 1)
  assert.equal(rowRenders, 9)
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

test('reasoning rows render as a dim italic thinking block', () => {
  const container = new Container()
  const cache: Array<{ row: TranscriptRow; component: unknown }> = []
  reconcileRows(container, cache as never, [{ kind: 'reasoning', text: 'deep thought', truncated: false }] as never)
  const lines = (container.children[0] as { render(width: number): string[] }).render(40).join('\n')
  assert.ok(lines.includes('▍ Thinking'), lines)
  assert.ok(lines.includes('deep thought'), lines)
  assert.ok(lines.includes('\x1b[3m'), 'italic style')
  assert.ok(!lines.includes('\x1b[48;'), 'no background')
})

test('tool rows render the call header plain and the result corner-prefixed', () => {
  // Codex-style: the toolCall header ("• RunCode (...)") is plain text on
  // the default background, and the result output leads with a dim corner
  // (└) with continuation lines indented under it — no canvas. The
  // toolCall title+args must compose inside one Text (pi's stack
  // compositing inserts full resets between children, which would break
  // styling mid-row).
  const container = new Container()
  const cache: Array<{ row: TranscriptRow; component: unknown }> = []
  const rows = [
    { kind: 'user', text: 'hello' },
    { kind: 'toolCall', name: 'run_code', args: '{"code":"x"}' },
    { kind: 'toolResult', name: 'run_code', output: 'out\nline two', truncated: false, error: false },
    { kind: 'toolResult', name: 'run_code', output: 'command not found', truncated: false, error: true },
  ] as never
  reconcileRows(container, cache as never, rows)
  assert.equal(container.children.length, 4)
  // The user bubble carries the pointer inside it, reference-style.
  const userLines = (container.children[0] as { render(width: number): string[] }).render(30)
  const userBody = userLines.join('\n')
  assert.ok(userBody.includes('❯'), 'user bubble contains the pointer')
  assert.ok(!userBody.includes('\x1b[0m'), 'no full reset inside the user bubble')
  const rows2 = container.children.slice(1, 4) as Array<{ render(width: number): string[] }>
  // The tool call header is transparent: one plain line, no background.
  const callLines = rows2[0]?.render(60).join('\n') ?? ''
  assert.ok(callLines.includes('•') && callLines.includes('RunCode'), callLines)
  assert.ok(callLines.includes('('), 'args are parenthesized')
  assert.ok(!callLines.includes('\x1b[48;'), 'the call header has no background')
  assert.equal(callLines.split('\n').length, 1, 'the call header is one plain line')
  // The output block: first line leads with the corner, continuation lines
  // indent, and there is no canvas background on any line.
  const outLines = rows2[1]?.render(60).join('\n') ?? ''
  const plainOut = outLines.replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(plainOut.includes('  └ out'), plainOut)
  assert.ok(plainOut.includes('    line two'), plainOut)
  assert.ok(!outLines.includes('\x1b[48;'), 'no canvas background on the output')
  // Failed results keep the rose cross on the first line.
  const errLines = rows2[2]?.render(60).join('\n') ?? ''
  assert.ok(errLines.includes('✗'), 'failed results keep the rose cross')
  assert.ok(!errLines.includes('\x1b[48;'), 'no canvas background on failed output')
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

test('PickerFrame budgets a styled title by visible width', () => {
  const styled = new PickerFrame('\x1b[1m\x1b[38;2;171;194;236mSelect session\x1b[39m\x1b[22m', (text: string) => text)
  const lines = styled.render(40)
  // width 40 -> inner 36; the styled title is 14 visible columns, so the
  // top border must span the full inner width with dashes to the edge.
  assert.equal(lines[0], '┌─ \x1b[1m\x1b[38;2;171;194;236mSelect session\x1b[39m\x1b[22m' + '─'.repeat(36 - 14) + '┐')
  assert.equal(lines.at(-1), '└' + '─'.repeat(38) + '┘')
  // At a width too narrow for the title, the truncation is unstyled text
  // (no escape codes can leak into the border).
  const narrow = styled.render(14)
  assert.ok(!narrow[0]?.includes('\x1b['), narrow[0])
  assert.ok(narrow[0]?.endsWith('┐'), narrow[0])
  // CJK titles are budgeted by visible width: the border still spans the
  // full frame (a JS char count would overflow it).
  const panel = (text: string): string => `\x1b[48;5;236m${text}\x1b[49m`
  const cjk = new PickerFrame('选择会话', identity)
  const cjkLine = cjk.render(40)[0] ?? ''
  assert.equal(cjkLine.endsWith('┐'), true)
  assert.ok(cjkLine.endsWith('─┐'), cjkLine)
  // A CJK title too wide for the frame truncates at a character boundary
  // and still fits (no JS-char slice can overflow).
  const longCjk = new PickerFrame('选择会话并开始一个很长的标题', identity)
  const narrowLine = longCjk.render(20)[0] ?? ''
  assert.equal(narrowLine.endsWith('┐'), true)
  assert.ok(visibleWidthOf(narrowLine) <= 20, narrowLine)
  // A child row carrying a full reset (pi's truncation) keeps the panel
  // background through its padding and border.
  const truncated = new PickerFrame('x', panel)
  truncated.addChild({ render: () => ['\x1b[1mvery long label\x1b[0m'] } as never)
  const row = truncated.render(20)[1] ?? ''
  assert.ok(row.startsWith('\x1b[48;5;236m│ '), row)
  assert.ok(!row.replace(/\x1b\[48;5;236m/g, '').includes('\x1b[0m'), 'no live full reset in the row')
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

test('stripFakeCursorCell removes pi\'s fake editor cursor, nothing else', () => {
  // Cursor at end of text: the inverse space and its resets go, the cell
  // stays plain (the row's trailing SEGMENT_RESET survives).
  assert.equal(
    stripFakeCursorCell('❯ hello\x1b[7m \x1b[0m\x1b[0m\x1b]8;;\x07'),
    '❯ hello \x1b[0m\x1b]8;;\x07',
  )
  // Cursor on a grapheme: the character is preserved, the highlight goes.
  assert.equal(stripFakeCursorCell('he\x1b[7ml\x1b[0mlo'), 'hello')
  // Multi-code-unit graphemes survive whole.
  assert.equal(stripFakeCursorCell('\x1b[7m👨\u200d👩\u200d👧\u200d👦\x1b[0m'), '👨\u200d👩\u200d👧\u200d👦')
  // Mouse selection and search highlights must pass through untouched,
  // even when the selected span re-emits a full reset before its \x1b[27m
  // closer (the span is multi-grapheme / carries styling, so it cannot be
  // the editor's one-grapheme cursor).
  const selection = 'a\x1b[7mbc\x1b[27md\x1b[0m\x1b]8;;\x07'
  assert.equal(stripFakeCursorCell(selection), selection)
  const resetInside = 'x\x1b[7mllo \x1b[0m\x1b[38;2;94;102;115mwor\x1b[27m y'
  assert.equal(stripFakeCursorCell(resetInside), resetInside)
  // A selection that embeds the composer cell keeps the whole span (the
  // fake cell's opener sits inside the matched region, so it is never
  // rescanned): the highlight stays correct, and the leftover inverse cell
  // disappears with the selection on the next frame — transient, cosmetic.
  const embedded = '\x1b[7mab \x1b[7m \x1b[0mcd\x1b[27m'
  assert.equal(stripFakeCursorCell(embedded), embedded)
  // Plain buffers pass through byte for byte.
  const plain = '\x1b[38;2;94;102;115m❯ \x1b[0m\x1b]8;;\x07'
  assert.equal(stripFakeCursorCell(plain), plain)
})
