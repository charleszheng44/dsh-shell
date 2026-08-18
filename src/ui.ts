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
  Container,
  Editor,
  HStack,
  Markdown,
  matchesKey,
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

import type { AppState, AppView, ProjectRow, SessionRow, SubmitResult } from './app.js'
import { partialSegments, type AssistantSegment, type TranscriptRow } from './transcript.js'
import { assistantMarker, editorTheme, footerStyle, headerStyle, markdownTheme, pickerPanelStyle, userMarker, userStyle } from './theme.js'

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
  const stripped = stripVTControlCharacters(normalized)
  // C0/C1 controls except LF and tab, plus the line/paragraph separators:
  // U+2028/U+2029 are invisible to many terminals and can smuggle content
  // past link-neutralization regexes.
  // C0/C1 controls except LF and tab, the line/paragraph separators, and
  // bidi/format controls (RLO, LRM, isolates, Arabic letter mark) that can
  // visually reorder or spoof transcript lines. U+200B (used by the link
  // neutralizer) is deliberately kept.
  return stripped.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u200E-\u200F\u202A-\u202E\u2066-\u2069\u061C]/g,
    '',
  )
}

/** ANSI-aware visible width: SGR sequences carry no columns. */
function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Bordered, titled panel around a picker list so the overlay reads as a
 *  separate panel instead of mixing with the transcript text. Keyboard input
 *  is delegated to the wrapped component (the SelectList owns selection). */
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
    const title = this.title.length > inner - 2 ? this.title.slice(0, inner - 2) : this.title
    const lines: string[] = []
    lines.push(this.style(`┌─ ${title}${'─'.repeat(Math.max(0, inner - title.length))}┐`))
    for (const row of rows) {
      const pad = Math.max(0, inner - visibleLength(row))
      lines.push(this.style(`│ ${row}${' '.repeat(pad)} │`))
    }
    lines.push(this.style(`└${'─'.repeat(inner + 2)}┘`))
    return lines
  }
}

/** One transcript line component: user text, assistant Markdown, or a tool
 *  result block. All carry a marker in its own column (green dot for user
 *  prompts, cyan block for model rows and tool output) so markers never
 *  interfere with Markdown parsing — a leading code fence must still be
 *  detected — and the marker columns align across rows. */
function rowComponent(row: TranscriptRow): Component {
  if (row.kind === 'user') {
    return new HStack([
      { component: new Text(userMarker(), 0, 0), basis: 3, grow: 0 },
      { component: new Text(userStyle(terminalSafeText(row.text)), 1, 0), basis: 'auto', grow: 1 },
    ])
  }
  if (row.kind === 'toolResult') {
    // Bounded tool output as a fenced code block; the fence is longer than
    // any backtick run in the output so it cannot close early.
    const longestRun = Math.max(0, ...(row.output.match(/`+/g)?.map((run) => run.length) ?? [0]))
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    const block = `${fence}\n${row.output}\n${fence}`
    return new HStack([
      { component: new Text(assistantMarker(), 0, 0), basis: 3, grow: 0 },
      { component: new Markdown(terminalSafeText(block), 1, 0, markdownTheme), basis: 'auto', grow: 1 },
    ])
  }
  return new HStack([
    { component: new Text(assistantMarker(), 0, 0), basis: 3, grow: 0 },
    { component: new Markdown(terminalSafeText(assistantMarkdown(row.segments)), 1, 0, markdownTheme), basis: 'auto', grow: 1 },
  ])
}

/** Terminal view: owns the Pi TUI, renders AppState, and shows pickers. */
export class TerminalView implements AppView {
  private readonly terminal = new ProcessTerminal()
  private readonly tui = new TuiAltScreen(this.terminal)
  private readonly transcript = new Container()
  private readonly partial = new Markdown('', 1, 0, markdownTheme)
  private readonly partialRow = new HStack([
    { component: new Text(assistantMarker(), 0, 0), basis: 3, grow: 0 },
    { component: this.partial, basis: 'auto', grow: 1 },
  ])
  private readonly header = new Text('', 1, 0)
  private readonly editor = new Editor(this.tui, editorTheme, { paddingX: 1 })
  private overlay: OverlayHandle | undefined

  constructor(
    private readonly onProject: () => void,
    private readonly onSession: () => void,
    private readonly onQuit: () => void,
    private readonly onSubmit: (text: string) => Promise<SubmitResult>,
  ) {
    this.editor.disableSubmit = true
    const footer = new Text(
      footerStyle('Ctrl+P project  Ctrl+S session  Ctrl+C quit\nApprovals and questions: use Web UI'),
      1,
      0,
    )
    const scroll = new ScrollView(this.transcript, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
    })
    const editorRow = new VStack([
      this.editor,
      footer,
    ])
    this.tui.setLayoutRoot(
      new VStack([
        { component: this.header, basis: 'auto', grow: 0, minSize: 1 },
        { component: scroll, basis: 0, grow: 1, minSize: 1 },
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
  }

  private editorEnabled = false

  render(state: AppState): void {
    this.header.setText(headerStyle(headerText(state)))
    this.renderTranscript(state.attachment)
    const policy = editorPolicy(state, this.overlay !== undefined)
    this.editorEnabled = policy.enabled
    this.editor.disableSubmit = policy.disableSubmit
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

  private renderTranscript(attachment: AppState['attachment']): void {
    const rows = attachment.phase === 'attached' ? attachment.transcript : []
    reconcileRows(this.transcript, this.rowCache, rows)
    // The live partial updates in place (single Markdown component) and stays
    // the last child, after every finalized row; the assistant marker column
    // is added only while there is in-flight content to show.
    this.transcript.removeChild(this.partialRow)
    if (attachment.phase === 'attached' && attachment.partial !== undefined) {
      this.partial.setText(terminalSafeText(assistantMarkdown(partialSegments(attachment.partial))))
      this.transcript.addChild(this.partialRow)
    } else {
      this.partial.setText('')
    }
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
    this.showPicker(items, 'Select project', (item) => {
      const row = rows.find((candidate) => String(candidate.key) === item.value)
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  openSessionPicker(rows: readonly SessionRow[], onSelect: (row: SessionRow) => void, onCancel: () => void): void {
    const items = sessionPickerItems(rows)
    if (rows.length === 0) {
      // Design: an empty project remains selectable and shows a notice; it
      // never creates a session, and Enter on the notice just closes.
      this.showPicker(items, 'Select session', () => undefined, onCancel)
      return
    }
    this.showPicker(items, 'Select session', (item) => {
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
    this.tui.stop()
  }

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

/** Status header: project / session / connection, with the notice appended. */
export function headerText(state: AppState): string {
  const attachment = state.attachment
  const sessionTitle = attachment.phase === 'attached' || attachment.phase === 'loading'
    ? attachment.sessionId
    : 'no session'
  const projectTitle = state.selectedProject === 'all'
    ? 'All sessions'
    : state.selectedProject === undefined
      ? 'no project'
      : state.projects.find((project) => project.key === state.selectedProject)?.title ?? 'unknown'
  const notice = state.notice === undefined ? '' : ` · ${state.notice}`
  return terminalSafeText(`${projectTitle} / ${sessionTitle} / ${state.connection}${notice}`)
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
