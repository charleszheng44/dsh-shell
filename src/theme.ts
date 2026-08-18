/**
 * Terminal color theme: ANSI SGR styling for every pi-tui component the TUI
 * renders. Theme functions wrap text in color codes (each includes the reset
 * so styles never bleed between lines); the picker panel uses a background
 * color so the overlay reads as a separate panel instead of mixing with the
 * transcript.
 */

import type { EditorTheme, MarkdownTheme } from '@earendil-works/pi-tui'

const RESET = '\x1b[0m'

function sgr(codes: string): (text: string) => string {
  return (text: string) => `\x1b[${codes}m${text}${RESET}`
}

const identity = (text: string): string => text
const bold = sgr('1')
const dim = sgr('2')
const italic = sgr('3')
const underline = sgr('4')
const strikethrough = sgr('9')
const fgGreen = sgr('32')
const fgYellow = sgr('33')
const fgCyan = sgr('36')
const boldCyan = sgr('1;36')
const boldBlue = sgr('1;34')
const cyanUnderline = sgr('4;36')
const dimItalic = sgr('2;3')
const dimRed = sgr('2;31')

/** Header line: bold bright cyan. */
export function headerStyle(text: string): string {
  return boldCyan(text)
}

/** User transcript rows: green, so your own prompts stand apart from the assistant. */
export function userStyle(text: string): string {
  return fgGreen(text)
}

/** Footer hint line: dim. */
export function footerStyle(text: string): string {
  return dim(text)
}

/** Picker panel background: dark gray, so the overlay separates from the transcript. */
export const pickerPanelStyle = sgr('48;5;236')

/** Assistant Markdown: headings blue, inline code (and Tool: markers) yellow,
 *  links cyan, quotes dim — readable on the default terminal background. */
export const markdownTheme: MarkdownTheme = {
  heading: boldBlue,
  link: cyanUnderline,
  linkUrl: dim,
  code: fgYellow,
  codeBlock: identity,
  codeBlockBorder: dim,
  quote: dimItalic,
  quoteBorder: dim,
  hr: dim,
  listBullet: fgCyan,
  bold,
  italic,
  strikethrough,
  underline,
}

/** Editor (cyan border) and the picker SelectList (cyan selection, dim
 *  descriptions and scroll info). */
export const editorTheme: EditorTheme = {
  borderColor: fgCyan,
  selectList: {
    selectedPrefix: (text: string) => `\x1b[1;36m▸ ${text}${RESET}`,
    selectedText: boldCyan,
    description: dim,
    scrollInfo: dim,
    noMatch: dimRed,
  },
}
