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
import { partialSegments, type TranscriptRow } from './transcript.js'

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
  const stack = new Container()
  for (const segment of row.segments) {
    if (segment.kind === 'text') {
      stack.addChild(new Markdown(terminalSafeText(segment.text), 1, 0, markdownTheme))
    } else if (segment.kind === 'tool') {
      stack.addChild(new Text(`Tool: ${terminalSafeText(segment.name)}`, 2, 0))
    } else {
      stack.addChild(new Text('[image]', 2, 0))
    }
  }
  return stack
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
  private pickerComponent: Component | undefined

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
    this.tui.setFocus(this.editor)
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
    this.header.setText(
      terminalSafeText(`${projectTitle} / ${sessionTitle} / ${state.connection}`),
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
      const text = partialSegments(attachment.partial)
        .map((segment) => segment.kind === 'text'
          ? segment.text
          : segment.kind === 'tool'
            ? `Tool: ${segment.name}`
            : '[image]')
        .join('\n')
      this.partial.setText(terminalSafeText(text))
      this.transcript.addChild(this.partial)
    }
  }

  openProjectPicker(rows: readonly ProjectRow[], onSelect: (row: ProjectRow) => void, onCancel: () => void): void {
    const items: SelectItem[] = rows.map((row) => ({
      value: String(row.key),
      label: terminalSafeText(row.title),
    }))
    this.showPicker(items, (item) => {
      const row = rows.find((candidate) => String(candidate.key) === item.value)
      if (row !== undefined) onSelect(row)
    }, onCancel)
  }

  openSessionPicker(rows: readonly SessionRow[], onSelect: (row: SessionRow) => void, onCancel: () => void): void {
    const items: SelectItem[] = rows.map((row) => ({
      value: String(row.sessionId),
      label: terminalSafeText(row.title),
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
    this.pickerComponent = list
    this.overlay = this.tui.showOverlay(list, {
      width: '60%',
      maxHeight: '50%',
      anchor: 'center',
    })
  }

  closePicker(): void {
    this.overlay?.hide()
    this.overlay = undefined
    this.pickerComponent = undefined
    this.tui.requestRender()
  }

  stop(): void {
    this.tui.stop()
  }
}
