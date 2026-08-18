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
  Markdown,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type OverlayHandle,
  type SelectItem,
} from '@earendil-works/pi-tui'

import type { AppState, AppView, ProjectRow, SessionRow } from './app.js'
import { partialSegments, type AssistantSegment, type TranscriptRow } from './transcript.js'

/** Safe picker label: the sanitized title (newlines collapsed so a DSH title
 *  cannot inject a row break into the SelectList), or a sanitized fallback so
 *  Pi's label || value render never exposes the raw DSH id/key. */
export function pickerLabel(title: string, fallback: string): string {
  const safe = terminalSafeText(title).replace(/\s+/g, ' ').trim()
  return safe || fallback
}

/** Assemble one assistant row's segments into a single Markdown document.
 *  Tool markers and images render as plain lines; the caller sanitizes.
 *  Link destinations are neutralized so Pi's Markdown never emits an OSC 8
 *  hyperlink carrying a DSH-controlled URL. */
export function assistantMarkdown(segments: readonly AssistantSegment[]): string {
  const joined = segments
    .map((segment) => segment.kind === 'text'
      ? segment.text
      : segment.kind === 'tool'
        ? `Tool: ${segment.name}`
        : '[image]')
    .join('\n\n')
  return neutralizeLinks(joined)
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
  if (/^(https?:\/\/|www\.)/i.test(token)) {
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

/** Neutralize every link form so no href reaches the terminal: [text](url),
 *  ![alt](url), <url> autolinks, bare URLs, and bare emails. Inside fenced
 *  code blocks links are code and stay untouched; fence state tracks the
 *  opening marker exactly. */
export function neutralizeLinks(markdown: string): string {
  const lines = markdown.split('\n')
  let fence: string | undefined
  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? ''
      if (fence === undefined) fence = marker
      else if (marker === fence) fence = undefined
      return line
    }
    if (fence !== undefined) return line
    let out = line
    out = out.replace(
      /!?\[([^\]]*)\]\(<?([^)>\s]*)>?(?:\s+"[^"]*")?\)/g,
      (_match, text: string, url: string) => `${text} (${breakAutolink(url)})`,
    )
    out = out.replace(/<([^<>\s]+)>/g, (_match, target: string) => breakAutolink(target))
    out = out.replace(/(^|\s)((?:https?:\/\/|mailto:|www\.)[^\s<]+)/gi, (_match, pre: string, url: string) => `${pre}${breakAutolink(url)}`)
    out = out.replace(/(^|[\s:(])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_match, pre: string, email: string) => `${pre}${breakAutolink(email)}`)
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
  return stripped.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

const identity = (text: string): string => text

const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
}

const markdownTheme: MarkdownTheme = {
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
}

/** One transcript line component: user text or assistant Markdown. */
function rowComponent(row: TranscriptRow): Component {
  if (row.kind === 'user') {
    return new Text(terminalSafeText(row.text), 1, 0)
  }
  return new Markdown(terminalSafeText(assistantMarkdown(row.segments)), 1, 0, markdownTheme)
}

/** Terminal view: owns the Pi TUI, renders AppState, and shows pickers. */
export class TerminalView implements AppView {
  private readonly terminal = new ProcessTerminal()
  private readonly tui = new TuiAltScreen(this.terminal)
  private readonly transcript = new Container()
  private readonly partial = new Markdown('', 1, 0, markdownTheme)
  private readonly header = new Text('', 1, 0)
  private readonly editor = new Editor(this.tui, editorTheme, { paddingX: 1 })
  private overlay: OverlayHandle | undefined

  constructor(
    private readonly onProject: () => void,
    private readonly onSession: () => void,
    private readonly onQuit: () => void,
  ) {
    this.editor.disableSubmit = true
    const footer = new Text(
      'Ctrl+P project  Ctrl+S session  Ctrl+C quit\nApprovals and questions: use Web UI',
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
    // PR 2 is read-only: keep focus off the editor so typed characters never
    // land in a disabled input whose content would be silently discarded.
    this.tui.setFocus(null)
    this.tui.start()
  }

  render(state: AppState): void {
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
    this.header.setText(
      terminalSafeText(`${projectTitle} / ${sessionTitle} / ${state.connection}${notice}`),
    )
    this.renderTranscript(attachment)
    this.editor.disableSubmit = true
    this.tui.requestRender()
  }

  private renderTranscript(attachment: AppState['attachment']): void {
    this.transcript.clear()
    if (attachment.phase !== 'attached') {
      this.partial.setText('')
      this.transcript.addChild(this.partial)
      return
    }
    for (const row of attachment.transcript) {
      this.transcript.addChild(rowComponent(row))
    }
    if (attachment.partial !== undefined) {
      this.partial.setText(terminalSafeText(assistantMarkdown(partialSegments(attachment.partial))))
      this.transcript.addChild(this.partial)
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
    this.showPicker(items, (item) => {
      const row = rows.find((candidate) => String(candidate.key) === item.value)
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  openSessionPicker(rows: readonly SessionRow[], onSelect: (row: SessionRow) => void, onCancel: () => void): void {
    if (rows.length === 0) {
      // Design: an empty project remains selectable and shows a notice; it
      // never creates a session, and Enter on the notice just closes.
      const items: SelectItem[] = [{ value: '', label: 'No attachable sessions' }]
      this.showPicker(items, () => undefined, onCancel)
      return
    }
    const items: SelectItem[] = rows.map((row) => ({
      value: String(row.sessionId),
      // Pi renders label || value; a title that sanitizes to empty must not
      // fall back to the raw DSH session id.
      label: pickerLabel(row.title, 'Session'),
    }))
    this.showPicker(items, (item) => {
      const row = rows.find((candidate) => String(candidate.sessionId) === item.value)
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  private showPicker(items: SelectItem[], onSelect: (item: SelectItem) => void, onCancel: () => void): void {
    this.closePicker()
    const list = new SelectList(items, 10, editorTheme.selectList)
    list.onSelect = (item) => {
      this.closePicker()
      onSelect(item)
    }
    list.onCancel = () => {
      this.closePicker()
      onCancel()
    }
    this.overlay = this.tui.showOverlay(list, {
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
