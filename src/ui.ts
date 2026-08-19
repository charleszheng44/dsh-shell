/**
 * Terminal presentation: Pi components, terminalSafeText(), and key bindings.
 *
 * Every string that originates from DSH passes through terminalSafeText()
 * before reaching a Pi component: model output, user echoes, titles, paths,
 * ids, notices, and error messages. Sanitization happens only at the display
 * edge; text submitted to DSH is never modified.
 */

import { stripVTControlCharacters } from 'node:util'
import {
  Box,
  Container,
  Editor,
  HStack,
  Markdown,
  matchesKey,
  visibleWidth,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from '@earendil-works/pi-tui'
import { wordWrapLine } from '@earendil-works/pi-tui/dist/components/editor.js'

import { queuedItemText, type AppState, type AppView, type ModelChoice, type PendingApproval, type ProjectRow, type QuestionItem, type SessionRow, type SubmitResult } from './app.js'
import { partialSegments, type AssistantSegment, type TranscriptRow } from './transcript.js'
import {
  assistantMarker,
  composerBorderStyle,
  contextStyle,
  editorTheme,
  footerStyle,
  headerStyle,
  markdownTheme,
  pickerPanelStyle,
  pickerTitleStyle,
  questionBoxBg,
  toolDisplayName,
  toolDotStyle,
  toolOutputStyle,
  toolResultStyle,
  toolTitleStyle,
  userBubbleBg,
  userMarker,
  userStyle,
  workingStyle,
} from './theme.js'

/** Safe picker label: the sanitized title (newlines collapsed so a DSH title
 *  cannot inject a row break into the SelectList), or a sanitized fallback so
 *  Pi's label || value render never exposes the raw DSH id/key. */
export function pickerLabel(title: string, fallback: string): string {
  const safe = terminalSafeText(title).replace(/\s+/g, ' ').trim()
  return safe || fallback
}

/** Assemble one assistant row's segments into a single Markdown document.
 *  Tool markers and images render as distinct lines; the caller sanitizes.
 *  Tool names are wrapped in backticks so they render as code (styled and
 *  never parsed as link text), and link destinations are neutralized so
 *  Pi's Markdown never emits an OSC 8 hyperlink carrying a DSH-controlled
 *  URL. */
export function assistantMarkdown(segments: readonly AssistantSegment[]): string {
  const joined = segments
    .map((segment) => segment.kind === 'text'
      ? segment.text
      : segment.kind === 'tool'
        ? segment.args === undefined
          ? `\`${segment.name}\``
          : `\`${segment.name}\` ${segment.args}`
        : '[image]')
    .join('\n\n')
  // Strip control characters BEFORE link neutralization: a control byte
  // inside a URL would break the neutralizer's regex and leave a live
  // OSC 8 hyperlink (terminalSafeText at the call sites then cannot see it).
  return neutralizeLinks(terminalSafeText(joined))
}

/** Break autolinking of one URL/email token so Pi's Markdown (marked) cannot
 *  recognize it as a link and emit an OSC 8 href: URLs get a zero-width space
 *  inside their scheme, emails get one right after the @. The spaces are
 *  invisible when rendered. */
function breakAutolink(token: string): string {
  if (token.length < 2) return token
  if (token.startsWith('mailto:')) {
    return `mail\u200Bto:${breakEmail(token.slice('mailto:'.length))}`
  }
  if (/^(https?|ftp):\/\/|www\./i.test(token)) {
    return `${token[0]}\u200B${token.slice(1)}`
  }
  return breakEmail(token)
}

/** Insert a zero-width space right after the @ of a bare email so marked
 *  cannot autolink it (the local part is no longer directly followed by a
 *  recognizable domain). */
function breakEmail(token: string): string {
  const at = token.indexOf('@')
  if (at === -1) return token
  return `${token.slice(0, at + 1)}\u200B${token.slice(at + 1)}`
}

/** Neutralize one plain (non-code) chunk of a line: convert inline links to
 *  "text (url)", break <url> autolinks, bare URLs (http/https/ftp/mailto/
 *  www, anywhere — marked needs no boundary), and bare emails (matching
 *  marked's looser coverage: one-character TLDs and underscores in domains).
 *  The URL token stops at ")" so adjacent parenthesized URLs are each broken
 *  instead of one greedy match swallowing both. */
function neutralizeChunk(chunk: string): string {
  let out = chunk
  out = out.replace(
    /!?\[((?:[^\[\]]|\[[^\]]*\])*)\]\(<?([^)>\s]*)>?(?:\s+"[^"]*")?\)/g,
    (_match, text: string, url: string) => `${text} (${breakAutolink(url)})`,
  )
  out = out.replace(/<([^<>\s]+)>/g, (_match, target: string) => breakAutolink(target))
  out = out.replace(/((?:https?|ftp):\/\/|mailto:|www\.)[^\s<)]+/gi, (url: string) => breakAutolink(url))
  out = out.replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g, (email: string) => breakEmail(email))
  return out
}

/** Neutralize every link form so no href reaches the terminal: [text](url),
 *  ![alt](url), <url> autolinks, bare URLs, and bare emails. Cross-line
 *  labels ([foo] then (url)) and reference-style pairs are closed URL-side:
 *  marked cannot form the link once the destination is broken, so brackets
 *  stay untouched and render literally. Inside fenced code blocks and inline
 *  code spans links are code and stay untouched; fence state tracks the
 *  opening marker exactly, and an unterminated inline code span is plain
 *  text again (marked never closes it, so it must be neutralized). */
export function neutralizeLinks(markdown: string): string {
  const lines = markdown.split('\n')
  // CommonMark fence state: open on <=3 spaces of indent, close on a line
  // whose marker run is at least as long as the opener's. marked follows
  // these rules; the neutralizer must not diverge or fenced links survive.
  let fence: { marker: string; length: number } | undefined
  return lines.map((line) => {
    const fenceMatch = line.match(/^ {0,3}(```+|~~~+)/)
    if (fenceMatch !== null && fenceMatch[1] !== undefined) {
      const marker = fenceMatch[1]
      const length = marker.length
      const char = marker[0] ?? ''
      // CommonMark: a backtick fence's info string may not contain
      // backticks; marked rejects such openers and treats the line as
      // text, so must we, or the "fence" would shelter a live URL.
      const info = line.slice(fenceMatch[0].length)
      if (char !== '`' || !info.includes('`')) {
        if (fence === undefined) {
          fence = { marker: char, length }
          return line
        }
        // marked closes a fence on a marker run >= the opener's length even
        // with trailing spaces/tabs (CommonMark allows trailing whitespace).
        const closeMatch = line.match(new RegExp(`^ {0,3}${fence.marker === '`' ? '`+' : '~+'}[ \t]*$`))
        if (fence.marker === char && length >= fence.length && closeMatch !== null) {
          fence = undefined
        }
        return line
      }
    }
    if (fence !== undefined) return line
    // Split the line into plain and inline-code spans (runs of backticks
    // toggle code state). Code content passes through untouched: marked
    // renders code spans verbatim and code content cannot become a link.
    const parts = line.split(/(`+)/)
    let inCode = false
    let out = ''
    let unclosed: string | undefined
    for (const part of parts) {
      if (part === '') continue
      if (/^`+$/.test(part)) {
        inCode = !inCode
        // A closing run ends the code span: nothing is unterminated anymore.
        if (!inCode) unclosed = undefined
        out += part
        continue
      }
      if (inCode) {
        unclosed = part
        out += part
        continue
      }
      unclosed = undefined
      out += neutralizeChunk(part)
    }
    // Unbalanced backticks: marked cannot close the code span, so the text
    // it would have sheltered is plain and must be neutralized.
    if (unclosed !== undefined) {
      out = out.slice(0, out.length - unclosed.length) + neutralizeChunk(unclosed)
    }
    return out
  }).join('\n')
}

/**
 * Make any DSH-derived string safe for terminal display: normalize CRLF and
 * bare CR to LF, strip ANSI/VT control sequences, then remove every remaining
 * C0/C1 control except LF and tab.
 */
export function terminalSafeText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  // DCS (ESC P ... ESC \, or the C1 single-byte 0x90 ... 0x9C form) carries
  // terminal payloads (query responses, sixel graphics);
  // stripVTControlCharacters removes the ESC bytes but leaves the payload as
  // literal text, so drop the whole run first. An unterminated run is
  // dropped to the end of the string: safety beats fidelity for a pasted
  // ESC P.
  const noDcs = normalized
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/\x90[\s\S]*?(?:\x9c|$)/g, '')
  const stripped = stripVTControlCharacters(noDcs)
  // C0/C1 controls except LF and tab, the line/paragraph separators
  // (U+2028/U+2029 are invisible to many terminals and can smuggle content
  // past link-neutralization regexes), and bidi/format controls (RLO, LRM,
  // isolates, Arabic letter mark) that can visually reorder or spoof
  // transcript lines. U+200B (used by the link neutralizer) is deliberately
  // kept.
  return stripped.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u200E-\u200F\u202A-\u202E\u2066-\u2069\u061C]/g,
    '',
  )
}

/** Truncate by visible columns, iterating code points so a CJK title is
 *  cut at a character boundary instead of overflowing the frame. */
function truncateByVisibleWidth(text: string, max: number): string {
  let result = ''
  for (const ch of text) {
    if (visibleWidth(result + ch) > max) break
    result += ch
  }
  return result
}

/** Bordered, titled panel around a picker list so the overlay reads as a
 *  separate panel instead of mixing with the transcript text. Keyboard input
 *  is delegated to the wrapped component (the SelectList owns selection).
 *  All budgets use pi's visibleWidth (CJK glyphs are two columns, so a JS
 *  character count would overflow the frame). */
export class PickerFrame implements Component {
  private readonly children: Component[] = []

  constructor(private readonly title: string, private readonly style: (text: string) => string) {}

  addChild(component: Component): void {
    this.children.push(component)
  }

  handleInput(data: string): void {
    // The overlay focuses this frame; route keys to the list inside it.
    for (const child of this.children) child.handleInput?.(data)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(8, width - 4)
    const rows = this.children.flatMap((child) => child.render(inner))
    // The title may carry ANSI styling (mist-blue picker titles), so the
    // border budget uses its visible width, never the raw code length —
    // slicing inside an escape sequence would leak styling into the border.
    // Truncation falls back to the unstyled text: pi's truncateToWidth would
    // append a full reset that kills the panel background on the border.
    const plain = this.title.replace(/\x1b\[[0-9;]*m/g, '')
    const title = visibleWidth(plain) > inner - 2 ? truncateByVisibleWidth(plain, inner - 2) : this.title
    const used = visibleWidth(title)
    // A child (the SelectList) truncates long labels with a full reset that
    // would kill the panel background for the row's padding and border;
    // re-apply the panel's background set-code after every such reset.
    const bgSet = this.style('').slice(0, this.style('').indexOf('m') + 1)
    const lines: string[] = []
    lines.push(this.style(`┌─ ${title}${'─'.repeat(Math.max(0, inner - used))}┐`))
    for (const row of rows) {
      const cleaned = bgSet === '' ? row : row.replace(/\x1b\[0m/g, bgSet)
      const pad = Math.max(0, inner - visibleWidth(cleaned))
      lines.push(this.style(`│ ${cleaned}${' '.repeat(pad)} │`))
    }
    lines.push(this.style(`└${'─'.repeat(inner + 2)}┘`))
    return lines
  }
}

/**
 * Transcript rendering as a flat cached-lines component. pi's layout walks
 * every child of a Container on every frame (measured ~100 ms at 1000 rows),
 * so every keystroke and animation tick paid the full tree cost. This
 * component holds the row components but composes their lines from its own
 * persistent per-row cache, and carries no layout node, so pi renders it
 * with a single render call: the per-frame cost is a flat join of cached
 * lines regardless of the transcript size. Transients (partial, question
 * card, working line, hint) are re-rendered fresh each frame — they change
 * every render by nature and are at most a few rows.
 */
export class TranscriptList implements Component {
  private rowComponents: readonly Component[] = []
  private transients: readonly Component[] = []
  private lines: Array<string[] | undefined> = []
  private lineWidth = -1
  private dirty = new Set<number>()

  /** Replace the row set; unchanged rows keep their cached lines. */
  setRows(rows: readonly Component[]): void {
    const old = this.rowComponents
    if (rows.length === old.length && rows.every((component, index) => component === old[index])) return
    for (let index = 0; index < Math.max(rows.length, old.length); index += 1) {
      if (rows[index] !== old[index]) this.dirty.add(index)
    }
    this.rowComponents = rows
  }

  setTransients(transients: readonly Component[]): void {
    if (transients.length === this.transients.length
      && transients.every((component, index) => component === this.transients[index])) return
    // A transient layout change shifts everything: recompute the whole list.
    this.transients = transients
    this.lines = []
    this.dirty.clear()
    for (let index = 0; index < this.rowComponents.length; index += 1) this.dirty.add(index)
  }

  invalidate(): void {
    // The TUI calls invalidate on the root every frame; the cache is managed
    // through setRows/setTransients, so there is nothing to do here.
  }

  handleInput(data: string): void {
    // The transcript never owns keyboard input.
  }

  render(width: number): string[] {
    if (width !== this.lineWidth) {
      this.lineWidth = width
      this.lines = []
      this.dirty.clear()
      for (let index = 0; index < this.rowComponents.length; index += 1) this.dirty.add(index)
    }
    const out: string[] = []
    for (let index = 0; index < this.rowComponents.length; index += 1) {
      const component = this.rowComponents[index]
      if (component === undefined) continue
      let lines = this.lines[index]
      if (lines === undefined || this.dirty.has(index)) {
        lines = component.render(width)
        this.lines[index] = lines
      }
      out.push(...lines)
    }
    for (const component of this.transients) out.push(...component.render(width))
    this.dirty.clear()
    return out
  }
}

/** Reconcile the transcript's row component cache against a row list and
 *  return the component array (TranscriptList consumes it; unchanged rows
 *  are reused so their cached lines stay valid). */
export function reconcileRowComponents(
  cache: Array<{ row: TranscriptRow; component: Component }>,
  rows: readonly TranscriptRow[],
): readonly Component[] {
  while (cache.length > rows.length) cache.pop()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as TranscriptRow
    const entry = cache[index]
    if (entry === undefined) {
      cache.push({ row, component: rowComponent(row) })
    } else if (entry.row !== row) {
      cache[index] = { row, component: rowComponent(row) }
    }
  }
  return cache.map((entry) => entry.component)
}

/** Number of tool-output lines previewed before the "+N more lines" note,
 *  matching pi's fallback preview. */
const TOOL_OUTPUT_PREVIEW_LINES = 10

/** One transcript line component. User prompts render as the reference's
 *  pointer-in-bubble (subtle chevron, warm off-white text on the mist
 *  bubble); assistant text as a mist-blue block plus plain Markdown; tool
 *  call headers as plain lines and tool results as boxed blocks (category
 *  dot, capitalized name, parenthesized args, bounded output). The
 *  assistant marker lives in its own column so it never interferes with
 *  Markdown parsing — a leading code fence must still be detected — while
 *  user and tool rows are full-width. Tool names, arguments, and outputs
 *  are host- or model-controlled text, so they pass through
 *  terminalSafeText like every other DSH-derived string. */
function rowComponent(row: TranscriptRow): Component {
  if (row.kind === 'user') {
    // The reference's user prompt: `❯ text` inside the bubble, pointer in
    // subtle gray, text in warm off-white — no separate marker column.
    const bubble = new Box(1, 1, userBubbleBg)
    const pointer = userMarker()
    bubble.addChild(new Text(`${pointer}${userStyle(terminalSafeText(row.text))}`, 0, 0))
    return bubble
  }
  if (row.kind === 'toolCall') {
    // Codex-style call header: the dot, display name, and parenthesized
    // arguments render as plain text on the default background (no card),
    // so only the result carries the grey canvas. The segments compose
    // into ONE Text with attribute-specific resets so no style bleeds
    // across the row.
    const dot = toolDotStyle(row.name, false)('• ')
    const title = toolTitleStyle(terminalSafeText(toolDisplayName(row.name)))
    // The reference's call header parenthesizes the arguments.
    const args = row.args === undefined ? '' : ` (${toolOutputStyle(terminalSafeText(row.args))})`
    return new Text(`${dot}${title}${args}`, 0, 0)
  }
  if (row.kind === 'toolResult') {
    // Codex-style output block: the first line leads with a dim corner and
    // continuation lines indent under it — plain text, no canvas, matching
    // how pi shows command run output. Failures keep the rose cross.
    const mark = row.error ? toolDotStyle(row.name, true)('✗ ') : ''
    const body = terminalSafeText(toolPreviewText(row.output, row.truncated)).split('\n')
    const lines = body.map((line, index) => {
      const prefix = index === 0 ? `  └ ${mark}` : '    '
      return `${footerStyle(prefix)}${toolResultStyle(line)}`
    })
    return new Text(lines.join('\n'), 0, 0)
  }
  return new HStack([
    { component: new Text(assistantMarker(), 0, 0), basis: 3, grow: 0 },
    { component: new Markdown(terminalSafeText(assistantMarkdown(row.segments)), 1, 0, markdownTheme), basis: 'auto', grow: 1 },
  ])
}

/** Bounded tool-output preview: pi shows the first 10 lines of a result with
 *  a "+N more lines" note. `truncated` comes from the projector's own bound
 *  (never sniffed from the content), and the note names the truncation so
 *  the bound is not hidden; the marker line, when present, is not counted
 *  as content. */
export function toolPreviewText(output: string, truncated: boolean): string {
  const lines = output.split('\n')
  const body = truncated && lines.at(-1) === '… (output truncated)' ? lines.slice(0, -1) : lines
  const preview = body.slice(0, TOOL_OUTPUT_PREVIEW_LINES)
  const remaining = body.length - preview.length
  if (remaining === 0) {
    // A truncated result whose content fits the preview entirely (e.g. the
    // 4000-char cap landing on a newline) must still show the bound.
    return truncated ? `${preview.join('\n')}\n… (output truncated)` : preview.join('\n')
  }
  return truncated
    ? `${preview.join('\n')}\n… +${remaining} more lines (output truncated)`
    : `${preview.join('\n')}\n… +${remaining} more lines`
}

/** Terminal view: owns the Pi TUI, renders AppState, and shows pickers. */
export class TerminalView implements AppView {
  private readonly terminal = new ProcessTerminal()
  // pi hides the hardware cursor by default and renders a static fake block
  // instead; passing true shows the real cursor (positioned at the editor's
  // marker every frame). The blink is done in software (start() toggles the
  // hardware cursor's visibility) so it works on every terminal.
  private readonly tui = new TuiAltScreen(this.terminal, true)
  private readonly transcript = new TranscriptList()
  private readonly partial = new Markdown('', 1, 0, markdownTheme)
  private readonly partialRow = new HStack([
    { component: new Text(assistantMarker(), 0, 0), basis: 3, grow: 0 },
    { component: this.partial, basis: 'auto', grow: 1 },
  ])
  /** "Deep diving..." turn-status line, rendered at the tail of the transcript
   *  (where the answer will stream in), like the Web UI's turn status. Empty
   *  Texts render zero rows, so idle layouts keep no slot. */
  private readonly working = new Text('', 0, 0)
  /** First-run hint while no session is attached. */
  private readonly hint = new Text('', 1, 0)
  /** Host question card: a boxed panel at the transcript tail while a
   *  question is open; the composer answers it. */
  private readonly questionBox = new Box(1, 1, questionBoxBg)
  private readonly questionText = new Text('', 1, 0)
  /** Host approval requests render as a boxed card at the transcript tail,
   *  answered with Ctrl+A (allow once) / Ctrl+R (reject). */
  private readonly approvalBox = new Box(1, 1, questionBoxBg)
  private readonly approvalText = new Text('', 1, 0)
  private readonly header = new Text('', 1, 0)
  /** pi-style usage/context line above the footer hints. */
  private readonly stats = new Text('', 1, 0)
  /** Pending prompt queue line; empty (zero rows) when nothing is queued. */
  private readonly queue = new Text('', 1, 0)
  private readonly hints = new Text('', 1, 0)
  private readonly editor = new Editor(this.tui, editorTheme, { paddingX: 1 })
  /** Composer prompt column: border corners on the first/last rows, the ❯
   *  marker on the first buffer row, blanks between — rebuilt to match the
   *  editor's wrapped height so the box has no blank margin rows. */
  private readonly prompt = new Text('', 0, 0)

  /** Rebuild the prompt column to mirror the editor's wrapped height: pi's
   *  Editor always renders a top border row, the visible buffer lines, and
   *  a bottom border row, so the column renders border corners (──) on its
   *  first and last rows and the ❯ marker on the first buffer row. The
   *  wrap math mirrors the editor's own layoutText (wordWrapLine at the
   *  content width) and its visible-line clamp, so the heights always
   *  match and the box carries no blank margin rows. */
  private lastPrompt = ''
  private updatePrompt(): void {
    const width = Math.max(1, this.terminal.columns - 2 - 2 * this.editor.getPaddingX())
    let wrapped = 0
    for (const line of this.editor.getLines()) {
      wrapped += line === '' || visibleWidth(line) <= width ? 1 : wordWrapLine(line, width).length
    }
    const maxVisible = Math.max(5, Math.floor(this.terminal.rows * 0.3))
    const count = Math.min(Math.max(1, wrapped), maxVisible)
    const rows = [composerBorderStyle('──')]
    rows.push(userMarker())
    for (let index = 1; index < count; index += 1) rows.push('  ')
    rows.push(composerBorderStyle('──'))
    const text = rows.join('\n')
    if (text === this.lastPrompt) return
    this.lastPrompt = text
    this.prompt.setText(text)
  }

  /** Rebuild the prompt column after a terminal resize (the editor re-wraps
   *  at the new width, so the column must re-mirror its height). */
  private readonly onTerminalResize = (): void => {
    this.updatePrompt()
    this.tui.requestRender()
  }
  private overlay: OverlayHandle | undefined
  /** The last rendered state: the Ctrl+U gate decides against what the user
   *  currently sees, not against frames that arrived since. */
  private latestState: AppState | undefined
  /** Reentry guard: a second Ctrl+U while a pop is in flight would target the
   *  same item id (the fresh snapshot only arrives after the host removes). */
  private editQueuedBusy = false
  /** Reentry guard for the steer action (Ctrl+Y): shares the queue-mutation
   *  window with the pop, so one in-flight mutation blocks the other. */
  private steerQueuedBusy = false

  constructor(
    private readonly onProject: () => void,
    private readonly onSession: () => void,
    private readonly onQuit: () => void,
    private readonly onSubmit: (text: string) => Promise<SubmitResult>,
    private readonly onEditQueued: () => Promise<string | undefined>,
    private readonly onModel: () => void,
    private readonly onApprove: (approvalId: string) => void,
    private readonly onReject: (approvalId: string) => void,
    private readonly onSteerQueued: () => Promise<void>,
  ) {
    this.editor.disableSubmit = true
    this.questionBox.addChild(this.questionText)
    this.approvalBox.addChild(this.approvalText)
    const footer = new VStack([
      // pi-style usage/context line; empty (zero rows) when unattached.
      { component: this.stats, basis: 'auto', grow: 0 },
      { component: this.hints, basis: 'auto', grow: 0 },
    ])
    const scroll = new ScrollView(this.transcript, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
    })
    // Codex-style composer: a ❯ prompt column leads the input line; the
    // editor takes the remaining width (pi computes the hardware cursor
    // column from the marker's position in the composed row, so the prompt
    // shifts it correctly). The prompt column mirrors the editor's height —
    // its first and last rows draw the border corners (─ in the accent
    // color) and the ❯ sits on the first buffer line — so the box's top and
    // bottom lines span the terminal with no blank margin rows inside.
    this.editor.onChange = () => this.updatePrompt()
    this.updatePrompt()
    const editorRow = new VStack([
      new HStack([
        { component: this.prompt, basis: 2, grow: 0 },
        { component: this.editor, basis: 0, grow: 1 },
      ], { align: 'start' }),
      footer,
    ])
    this.tui.setLayoutRoot(
      new VStack([
        { component: this.header, basis: 'auto', grow: 0, minSize: 1 },
        { component: scroll, basis: 0, grow: 1, minSize: 1 },
        // The queue preview sits above the input box, right under the
        // transcript (whose tail carries the Deep diving status line).
        { component: this.queue, basis: 'auto', grow: 0 },
        { component: editorRow, basis: 'auto', grow: 0, minSize: 1 },
      ]),
    )
    this.editor.onSubmit = (text) => {
      this.editor.disableSubmit = true // guard reentry
      void this.onSubmit(text).then((result) => {
        // pi clears the buffer before onSubmit; keep or restore the editor
        // text per the design (accepted clears, rejected retains). Restore
        // only when the user has not typed a new draft while the call was in
        // flight, and sanitize at the display edge (the wire copy stays
        // verbatim; the restored text is the user's own, but pasted C1
        // controls must not render raw in the buffer).
        if (this.editor.getText() === '') {
          this.editor.setText(terminalSafeText(editorTextAfterSubmit(result, text)))
        }
        // A prompt that ran joins the up-arrow recall history (pi trims and
        // dedupes consecutive repeats). The history copy is sanitized: pi
        // restores recalled entries without the C0/C1 filters that typed and
        // pasted input pass through, so a pasted control character must not
        // survive in the buffer to be re-rendered raw on every recall. The
        // wire copy above stays verbatim. Rejected submissions stay out.
        if (result.ok) this.editor.addToHistory(terminalSafeText(text))
        // The App renders the notice; re-enable for the next attempt.
        this.editor.disableSubmit = !this.editorEnabled
      })
    }
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+p')) {
        this.onProject()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+s')) {
        this.onSession()
        return { consume: true }
      }
      if ((matchesKey(data, 'ctrl+o') || (matchesKey(data, 'ctrl+m') && data !== '\r'))) {
        // Model/effort picker: only meaningful while attached on a live
        // stream with no overlay open; otherwise the key falls through.
        // Ctrl+O is the universal binding (no terminal ambiguity). Ctrl+M
        // additionally works on kitty-protocol terminals — in legacy
        // terminals Ctrl+M is the SAME byte as Enter (CR 0x0D), so plain
        // Enter must never open the picker, and only the disambiguated
        // kitty CSI-u form (\x1b[109;5u) can mean Ctrl+M.
        const state = this.latestState
        if (state !== undefined
          && state.connection === 'connected'
          && state.attachment.phase === 'attached'
          && this.overlay === undefined) {
          this.onModel()
          return { consume: true }
        }
        return undefined
      }
      if (matchesKey(data, 'ctrl+a') || matchesKey(data, 'ctrl+r')) {
        // Answer a pending approval: Ctrl+A allows once, Ctrl+R rejects.
        // With no approval pending the key falls through to the editor's
        // native bindings.
        const state = this.latestState
        const first = state !== undefined
          && state.connection === 'connected'
          && state.attachment.phase === 'attached'
          ? state.attachment.pendingApprovals[0]
          : undefined
        if (first !== undefined && this.overlay === undefined) {
          if (matchesKey(data, 'ctrl+a')) this.onApprove(String(first.approvalId))
          else this.onReject(String(first.approvalId))
          return { consume: true }
        }
        return undefined
      }
      if (matchesKey(data, 'ctrl+y')) {
        // Steer the last queued message into the running agent. Gated like
        // the pop (attached, live, no overlay/question/submission, and no
        // other queue mutation in flight); otherwise the key falls through
        // to the editor's native yank.
        if (this.latestState === undefined
          || !canEditQueued(this.latestState, this.overlay !== undefined, this.editQueuedBusy || this.steerQueuedBusy)) {
          return undefined
        }
        this.steerQueuedBusy = true
        void this.onSteerQueued().finally(() => {
          this.steerQueuedBusy = false
        })
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+u')) {
        // Codex's edit-last-queued: pop the last queued message back into the
        // composer. pi cannot reliably decode Alt+Up, so Ctrl+U is the
        // binding, matching the hint in the queue preview. Gated so the
        // editor's native binding keeps working when there is nothing to pop,
        // and so an open question or picker cannot have its draft/selection
        // clobbered by a pop.
        if (this.latestState === undefined
          || !canEditQueued(this.latestState, this.overlay !== undefined, this.editQueuedBusy)) {
          return undefined
        }
        this.editQueuedBusy = true
        this.editor.disableSubmit = true // guard reentry
        // Capture the composer at keypress: landing replaces whatever was
        // there (Codex's edit-last-queued replaces the buffer), so a pop
        // with a draft must not be lost; only keystrokes made DURING the
        // flight (a changed buffer) win over the restore.
        const draftAtPress = this.editor.getText()
        void this.onEditQueued().then((text) => {
          // Mid-flight guards mirroring render(): never rip focus from a
          // picker opened while the pop was in flight, never land text into
          // the composer while a question flipped it into answering mode or
          // the session disconnected, and never clobber keystrokes made
          // while the pop was in flight. An all-control message sanitizes
          // to empty and must not clear the composer either.
          const attachment = this.latestState?.attachment
          const answering = attachment !== undefined && attachment.phase === 'attached' && attachment.pendingQuestions.length > 0
          const clean = terminalSafeText(text ?? '')
          if (text !== undefined
            && clean !== ''
            && !answering
            && this.latestState?.connection === 'connected'
            && this.overlay === undefined
            && this.editor.getText() === draftAtPress) {
            this.editor.setText(clean)
            this.tui.setFocus(this.editor)
          }
        }).catch(() => {
          // The port folds every failure into a result, so this is belt and
          // braces; the busy guard must not stay stuck either way.
        }).finally(() => {
          this.editQueuedBusy = false
          this.editor.disableSubmit = !this.editorEnabled
        })
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+c')) {
        this.onQuit()
        return { consume: true }
      }
      return undefined
    })
  }

  start(): void {
    // Focus starts off the editor; render() moves focus to it once an
    // attached session enables input.
    this.tui.setFocus(null)
    this.tui.start()
    // Codex-style blinking cursor. Terminals that ignore the DECSCUSR
    // style sequence (macOS Terminal) would keep a steady cursor, so the
    // blink is done in software: a timer toggles the hardware cursor's
    // visibility every half-second, flashing between the terminal's block
    // and pi's hollow reverse-video cell. DECSCUSR 2 (steady block) keeps
    // terminals that DO honor the sequence from double-blinking.
    this.terminal.write('\x1b[2 q')
    process.stdout.on('resize', this.onTerminalResize)
    this.cursorBlinkTimer = setInterval(() => {
      this.cursorVisible = !this.cursorVisible
      this.tui.setShowHardwareCursor(this.cursorVisible)
      this.tui.requestRender()
    }, 530)
  }

  private editorEnabled = false

  /** Software cursor blink: pi renders the editor's fake reverse-video cell
   *  always, and the hardware cursor (when shown) covers it; toggling the
   *  hardware cursor's visibility flashes between the two states on every
   *  terminal, DECSCUSR support or not. */
  private cursorBlinkTimer: ReturnType<typeof setInterval> | undefined
  private cursorVisible = true

  /** Animation state for the Deep diving status: the dots cycle 0-3 on a
   *  timer so the line visibly "flashes" while the session is working. */
  private workingDots = 0
  private workingActive = false
  private workingTimer: ReturnType<typeof setInterval> | undefined

  render(state: AppState): void {
    this.latestState = state
    this.updatePrompt()
    this.header.setText(headerStyle(headerText(state)))
    this.workingActive = isWorking(state)
    if (this.workingActive && this.workingTimer === undefined) {
      this.workingTimer = setInterval(() => {
        this.workingDots = (this.workingDots + 1) % 4
        this.working.setText(workingStyle(deepDivingText(this.workingDots)))
        this.tui.requestRender()
      }, 400)
    } else if (!this.workingActive && this.workingTimer !== undefined) {
      clearInterval(this.workingTimer)
      this.workingTimer = undefined
      this.workingDots = 0 // next working period starts from a clean frame
    }
    this.working.setText(this.workingActive ? workingStyle(deepDivingText(this.workingDots)) : '')
    this.stats.setText(statsText(state.attachment))
    // Queue, answering hints, and the question card only make sense on a live
    // stream: after a disconnect the header explains the state.
    const connected = state.connection === 'connected'
    this.queue.setText(connected ? queuedText(state.attachment) : '')
    this.hints.setText(this.overlay !== undefined
      ? footerStyle('↑↓ move · Enter select · ESC cancel')
      : connected
        ? footerHints(state.attachment)
        : footerStyle('Ctrl+P project  Ctrl+S session  Ctrl+C quit\nApprovals and questions: use Web UI'))
    this.renderTranscript(state.attachment, connected)
    const policy = editorPolicy(state, this.overlay !== undefined)
    this.editorEnabled = policy.enabled
    // A render mid-pop must not re-enable Enter while the pop RPC is in
    // flight (the Ctrl+U path sets disableSubmit itself, but every render
    // would otherwise overwrite it from the policy).
    this.editor.disableSubmit = policy.disableSubmit || this.editQueuedBusy
    if (policy.clearText) {
      this.editor.setText('')
      // A disconnect or detach while a picker is open must not rip focus
      // from the SelectList (mirrors the focus-to-editor guard below).
      if (this.overlay === undefined) this.tui.setFocus(null)
    } else if (policy.focusEditor) {
      this.tui.setFocus(this.editor)
    }
    this.tui.requestRender()
  }

  /** Per-index row cache so live streaming updates rows in place. */
  private rowCache: Array<{ row: TranscriptRow; component: Component }> = []

  private renderTranscript(attachment: AppState['attachment'], connected: boolean): void {
    const rows = attachment.phase === 'attached' ? attachment.transcript : []
    this.transcript.setRows(reconcileRowComponents(this.rowCache, rows))
    const transients: Component[] = []
    // First-run hint while nothing is attached; removed as soon as any
    // attachment phase begins.
    if (attachment.phase === 'none') {
      this.hint.setText(footerStyle('Press Ctrl+P or Ctrl+S to pick a project and session'))
      transients.push(this.hint)
    }
    // The live partial updates in place (single Markdown component) and stays
    // after every finalized row; the assistant marker column is added only
    // while there is in-flight content to show.
    if (attachment.phase === 'attached' && attachment.partial !== undefined) {
      this.partial.setText(terminalSafeText(assistantMarkdown(partialSegments(attachment.partial))))
      transients.push(this.partialRow)
    } else {
      this.partial.setText('')
    }
    // An open host approval renders as a boxed card at the transcript tail,
    // answered with Ctrl+A / Ctrl+R until approval/resolved settles it.
    // Only the first pending approval is shown at a time.
    if (connected && attachment.phase === 'attached' && attachment.pendingApprovals.length > 0) {
      const pending = attachment.pendingApprovals[0]
      if (pending !== undefined) {
        this.approvalText.setText(approvalCardText(pending))
        transients.push(this.approvalBox)
      }
    }
    // An open host question renders as a boxed card above the status line;
    // the composer answers it until question/resolved settles it. Only the
    // first pending question is shown and answerable at a time; the host
    // settles sequentially, so a second ask waits for the first. The card
    // disappears on disconnect, like the queue line and answering hints.
    if (connected && attachment.phase === 'attached' && attachment.pendingQuestions.length > 0) {
      const pending = attachment.pendingQuestions[0]
      if (pending !== undefined) {
        this.questionText.setText(questionCardText(pending.questions))
        transients.push(this.questionBox)
      }
    }
    // The Deep diving status is the very last row of the transcript, below
    // the streaming partial — the Web UI renders its turn status at the tail
    // of the conversation, after the last content node.
    if (this.workingActive) transients.push(this.working)
    this.transcript.setTransients(transients)
  }

  openProjectPicker(rows: readonly ProjectRow[], onSelect: (row: ProjectRow) => void, onCancel: () => void): void {
    const items: SelectItem[] = rows.map((row) => {
      // Pi renders label || value; a title that sanitizes to empty must not
      // fall back to the raw DSH key, so provide a sanitized fallback label.
      const fallback = String(row.key) === 'all' ? 'All sessions' : 'Workspace'
      return {
        value: String(row.key),
        label: pickerLabel(row.title, fallback),
      }
    })
    this.showPicker(items, pickerTitleStyle('Select project'), (item) => {
      const row = rows.find((candidate) => String(candidate.key) === item.value)
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  openModelPicker(choices: readonly ModelChoice[], onSelect: (choice: ModelChoice) => void, onCancel: () => void): void {
    const items: SelectItem[] = choices.map((choice) => ({
      value: `${choice.provider}\u0000${choice.model}\u0000${choice.effortId ?? ''}`,
      label: pickerLabel(choice.name, 'Model'),
      ...(choice.description === undefined ? {} : { description: pickerLabel(choice.description, '') }),
    }))
    this.showPicker(items, pickerTitleStyle('Select model'), (item) => {
      const [provider, model, effortId] = item.value.split('\u0000')
      const row = choices.find((candidate) => candidate.provider === provider
        && candidate.model === model
        && (candidate.effortId ?? '') === (effortId ?? ''))
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  openSessionPicker(rows: readonly SessionRow[], onSelect: (row: SessionRow) => void, onCancel: () => void): void {
    const items = sessionPickerItems(rows)
    if (rows.length === 0) {
      // Design: an empty project remains selectable and shows a notice; it
      // never creates a session, and Enter on the notice just closes.
      this.showPicker(items, pickerTitleStyle('Select session'), () => undefined, onCancel)
      return
    }
    this.showPicker(items, pickerTitleStyle('Select session'), (item) => {
      const row = rows.find((candidate) => String(candidate.sessionId) === item.value)
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  private showPicker(items: SelectItem[], title: string, onSelect: (item: SelectItem) => void, onCancel: () => void): void {
    this.closePicker()
    const frame = new PickerFrame(title, pickerPanelStyle)
    const list = new SelectList(items, 10, editorTheme.selectList)
    list.onSelect = (item) => {
      this.closePicker()
      onSelect(item)
    }
    list.onCancel = () => {
      this.closePicker()
      onCancel()
    }
    frame.addChild(list)
    this.overlay = this.tui.showOverlay(frame, {
      width: '60%',
      maxHeight: '50%',
      anchor: 'center',
    })
  }

  closePicker(): void {
    this.overlay?.hide()
    this.overlay = undefined
    this.tui.requestRender()
  }

  stop(): void {
    process.stdout.removeListener('resize', this.onTerminalResize)
    if (this.cursorBlinkTimer !== undefined) {
      clearInterval(this.cursorBlinkTimer)
      this.cursorBlinkTimer = undefined
    }
    if (this.workingTimer !== undefined) {
      clearInterval(this.workingTimer)
      this.workingTimer = undefined
    }
    this.tui.stop()
    // Restore the terminal's default cursor style (blinking block) on the
    // main screen; the alt-screen exit does not reset DECSCUSR.
    this.terminal.write('\x1b[0 q')
  }

}

/** The Web UI's turn status text with 0-3 trailing dots; the cycling is the
 *  terminal's stand-in for the Web shimmer animation. */
export function deepDivingText(dots: number): string {
  return `Deep diving${'.'.repeat(Math.max(0, Math.min(3, dots)))}`
}

/** Whether a turn is in flight for the attached session: our prompt call is
 *  still being admitted, or a turn/start has been seen without its turn/end.
 *  Drives the Deep diving status line. */
export function isWorking(state: AppState): boolean {
  return state.connection === 'connected'
    && state.attachment.phase === 'attached'
    && (state.attachment.sending || state.attachment.turnActive !== undefined)
}

/** Reconcile the transcript's row cache with a row list: dropped rows have
 *  their components removed (so a shorter transcript or a session switch
 *  never leaves stale rows rendered), new rows get components, and changed
 *  rows are rebuilt in place. Exported for unit testing without a TTY.
 *
 *  Invariant: within one attachment the row list only grows or replaces a
 *  row at its own index; every session switch passes through an empty list
 *  (loading/none), which clears the cache, so a changed row is always the
 *  last one. A non-tail replacement would reorder children (removeChild +
 *  addChild appends) and must not happen. */
export function reconcileRows(
  container: Container,
  cache: Array<{ row: TranscriptRow; component: Component }>,
  rows: readonly TranscriptRow[],
): void {
  while (cache.length > rows.length) {
    const stale = cache.pop()
    if (stale !== undefined) container.removeChild(stale.component)
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as TranscriptRow
    const entry = cache[index]
    if (entry === undefined) {
      const component = rowComponent(row)
      cache.push({ row, component })
      container.addChild(component)
    } else if (entry.row !== row) {
      const component = rowComponent(row)
      container.removeChild(entry.component)
      container.addChild(component)
      cache[index] = { row, component }
    }
  }
}

/** Editor content after a submit attempt: cleared on acceptance, retained
 *  (restored) on any other outcome except a stale session switch. */
export function editorTextAfterSubmit(result: SubmitResult, submitted: string): string {
  if (result.ok) return ''
  if (result.reason === 'stale') return ''
  return submitted
}

/** Editor policy for one render. The editor is enabled only for a connected,
 *  attached session; submission is additionally disabled while a call is in
 *  flight; focus moves to the editor only when no picker overlay is open
 *  (live frames must not steal focus while the user is selecting); and the
 *  text is cleared whenever the editor is disabled. */
export function editorPolicy(
  state: AppState,
  overlayOpen: boolean,
): { enabled: boolean; disableSubmit: boolean; focusEditor: boolean; clearText: boolean } {
  const enabled = state.connection === 'connected'
    && state.attachment.phase === 'attached'
  const sending = state.attachment.phase === 'attached' && state.attachment.sending
  return {
    enabled,
    disableSubmit: !enabled || sending,
    focusEditor: enabled && !overlayOpen,
    clearText: !enabled,
  }
}

/** Status header: project / session / connection, with the notice appended.
 *  The attached session shows its picker title, falling back to the id when
 *  the title sanitizes to empty. */
export function headerText(state: AppState): string {
  const attachment = state.attachment
  const sessionTitle = attachment.phase === 'attached' || attachment.phase === 'loading'
    // A DSH title cannot inject a row break: whitespace collapses like the
    // picker's labels, and an empty result falls back to the id.
    ? terminalSafeText(attachment.title).replace(/\s+/g, ' ').trim() || String(attachment.sessionId)
    : 'no session'
  const projectTitle = state.selectedProject === 'all'
    ? 'All sessions'
    : state.selectedProject === undefined
      ? 'no project'
      : terminalSafeText(state.projects.find((project) => project.key === state.selectedProject)?.title ?? 'unknown')
        .replace(/\s+/g, ' ')
        .trim()
  const notice = state.notice === undefined ? '' : ` · ${terminalSafeText(state.notice).replace(/\s+/g, ' ').trim()}`
  return terminalSafeText(`${projectTitle} / ${sessionTitle} / ${state.connection}${notice}`)
}

/** Format a token count like pi's footer: 999 -> "999", 1500 -> "1.5k", 42000 -> "42k". */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

/** pi-style usage line for the footer: ↑input ↓output R-cache W-cache and the
 *  context percentage (colored past pi's warning/error thresholds). */
export function statsText(attachment: AppState['attachment']): string {
  if (attachment.phase !== 'attached' || attachment.stats === undefined) return ''
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, pressureTokens, contextWindow } = attachment.stats
  // A non-positive window is degenerate: no context percentage, no line.
  if (contextWindow <= 0) return ''
  const percent = (pressureTokens / contextWindow) * 100
  // R and W gates are independent, like pi's footer: no "R0" when only cache
  // writes exist.
  const read = cacheReadTokens > 0 ? ` · R${formatTokens(cacheReadTokens)}` : ''
  const write = cacheWriteTokens > 0 ? ` · W${formatTokens(cacheWriteTokens)}` : ''
  const context = contextStyle(percent, `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`)
  // The reference's byline separates the stats parts with U+00B7; the
  // current model (and effort level) sits right next to the context usage.
  const model = attachment.modelLabel
  const stats = `${footerStyle(`↑${formatTokens(uncachedInputTokens)} · ↓${formatTokens(outputTokens)}${read}${write} `)}${context}`
  return model === undefined ? stats : `${stats}${footerStyle(` · ${model}`)}`
}

/** Codex-style queue preview panel: a bulleted section in the footer under
 *  the composer listing the queued follow-up inputs (dim, indented) with the
 *  edit hint. Bounded: at most MAX_QUEUED_ROWS items, each item's text
 *  capped at MAX_QUEUED_WIDTH visible columns (a full row is ~66 columns),
 *  so a long paste or a hostile host cannot crush the composer or the
 *  transcript off-screen. Empty when nothing is queued, so the footer keeps
 *  no rows. The edit hint is hidden while a question is open: the Ctrl+U
 *  gate is off then, and the hint must not advertise a key that would
 *  clobber the answer draft. */
export const MAX_QUEUED_ROWS = 4
export const MAX_QUEUED_WIDTH = 60
export function queuedText(attachment: AppState['attachment']): string {
  if (attachment.phase !== 'attached') return ''
  const queued = attachment.queue.filter((item) => item.placement === 'queued')
  if (queued.length === 0) return ''
  const lines = ['• Queued follow-up inputs']
  for (const item of queued.slice(0, MAX_QUEUED_ROWS)) {
    const text = terminalSafeText(queuedItemText(item)).replace(/\s+/g, ' ').trim()
    // An item with no text part is still in the queue (Ctrl+U pops and
    // removes it); show a placeholder instead of a bare indent row.
    const preview = text === '' ? '(no preview)' : truncateByVisibleWidth(text, MAX_QUEUED_WIDTH)
    lines.push(`  ↳ ${preview}${visibleWidth(text) > MAX_QUEUED_WIDTH ? '…' : ''}`)
  }
  if (queued.length > MAX_QUEUED_ROWS) {
    lines.push(`  … +${queued.length - MAX_QUEUED_ROWS} more queued`)
  }
  // The hint is hidden while a question is open or a prompt submission is
  // in flight: the Ctrl+U gate is off then, and the hint must not advertise
  // a key that would clobber the answer draft or remove the wrong item.
  if (attachment.pendingQuestions.length === 0 && attachment.sending !== true) {
    lines.push('    Ctrl+U edit · Ctrl+Y steer last queued message')
  }
  return lines.map((line) => footerStyle(line)).join('\n')
}

/** Whether Ctrl+U may pop the last queued message back into the composer:
 *  attached and live, no question being answered, no prompt submission in
 *  flight, no picker overlay open, no pop already in flight, and at least
 *  one queued item. When false the key falls through to the editor (its
 *  native Ctrl+U) or the overlay, so an open question's draft or a picker's
 *  selection is never clobbered. */
export function canEditQueued(state: AppState, overlayOpen: boolean, busy: boolean): boolean {
  if (busy || overlayOpen) return false
  if (state.connection !== 'connected' || state.attachment.phase !== 'attached') return false
  if (state.attachment.pendingQuestions.length > 0 || state.attachment.sending) return false
  return state.attachment.queue.some((item) => item.placement === 'queued')
}

/** Footer hints: while a question is open the composer answers it, and
 *  while an approval is pending Ctrl+A/Ctrl+R decide it. */
export function footerHints(attachment: AppState['attachment']): string {
  const question = attachment.phase === 'attached' && attachment.pendingQuestions.length > 0
  const approval = attachment.phase === 'attached' && attachment.pendingApprovals.length > 0
  const keys = 'Ctrl+P project  Ctrl+S session  Ctrl+O model  Ctrl+C quit'
  const mode = approval
    ? 'Ctrl+A allow once · Ctrl+R reject · Enter send · ↑ history'
    : question
      ? 'Answer: a number picks an option, commas pick several, any text answers'
      : 'Enter send · ↑ history · Approvals and questions: use Web UI'
  return footerStyle(`${keys}\n${mode}`)
}

/** The approval card's content: the tool being approved (with the host's
 *  reason, flattened) and the answer keys. */
export function approvalCardText(approval: PendingApproval): string {
  const name = toolDisplayName(terminalSafeText(approval.toolName))
  const reason = approval.reason === undefined
    ? ''
    : ` — ${terminalSafeText(approval.reason).replace(/\s+/g, ' ').trim()}`
  return `Approval: ${name}${reason}\n  Ctrl+A allow once · Ctrl+R reject`
}

/** The question card's content: the question text (with the supporting
 *  detail — for plan-review intents the detail IS the plan — and a
 *  multi-select note), then the numbered options. */
export function questionCardText(questions: readonly QuestionItem[]): string {
  return questions.map((question) => {
    const options = (question.options ?? [])
      .map((option, index) => `  ${index + 1}. ${terminalSafeText(option.label).replace(/\s+/g, ' ').trim()}`)
      .join('\n')
    const text = terminalSafeText(question.question).replace(/\s+/g, ' ').trim()
    const select = question.multiSelect === true ? ' (choose any)' : ''
    // The detail is flattened to one run: for plan-review asks the detail IS
    // the plan markdown, and the terminal card shows it collapsed (the Web
    // renders it as structured text).
    const detail = question.detail === undefined || question.detail === ''
      ? ''
      : `\n  ${terminalSafeText(question.detail).replace(/\s+/g, ' ').trim()}`
    return `? ${text}${select}${detail}${options === '' ? '' : `\n${options}`}`
  }).join('\n')
}

/** Picker items for a session list: the empty case shows a notice row. */
export function sessionPickerItems(rows: readonly SessionRow[]): SelectItem[] {
  if (rows.length === 0) {
    return [{ value: '', label: 'No attachable sessions' }]
  }
  return rows.map((row) => ({
    value: String(row.sessionId),
    // Pi renders label || value; a title that sanitizes to empty must not
    // fall back to the raw DSH session id.
    label: pickerLabel(row.title, 'Session'),
  }))
}
