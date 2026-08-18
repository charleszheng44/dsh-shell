/**
 * Terminal color theme: ANSI SGR styling for every pi-tui component the TUI
 * renders, aligned with the pi coding agent's dark palette (gold headings,
 * teal accent/code, green code blocks, gray quotes, message bubbles and
 * tool boxes with their own backgrounds). Theme functions wrap text in color
 * codes (each includes the reset so styles never bleed between lines); the
 * picker panel uses a background color so the overlay reads as a separate
 * panel instead of mixing with the transcript.
 */

import { getCapabilities, type EditorTheme, type MarkdownTheme } from '@earendil-works/pi-tui'

/** Attribute-specific reset for one SGR set-code: bold/italic/underline/color
 *  reset only what they set, so a background applied around styled text
 *  (bubbles, tool boxes, the picker panel) survives the inner resets — a full
 *  \x1b[0m would kill the line's background for everything after the first
 *  styled token. This mirrors pi's theme functions (fg ends in 39, bg in 49). */
function sgr(codes: string): (text: string) => string {
  const parts = codes.split(';')
  const resets: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const code = Number(parts[index])
    if (code === 38 || code === 48) {
      // Extended color (38;5;i or 38;2;r;g;b): the parameters are color
      // values, not SGR codes — skip them and reset only the color.
      const mode = Number(parts[index + 1])
      resets.push(code === 38 ? '39' : '49')
      index += mode === 2 ? 4 : mode === 5 ? 2 : 0
    } else if (code === 1 || code === 2) {
      resets.push('22')
    } else if (code === 3) {
      resets.push('23')
    } else if (code === 4) {
      resets.push('24')
    } else if (code === 9) {
      resets.push('29')
    } else if (code >= 30 && code <= 37) {
      resets.push('39')
    } else if (code >= 40 && code <= 47) {
      resets.push('49')
    } else {
      resets.push('0')
    }
  }
  const reset = resets.join(';')
  return (text: string) => `\x1b[${codes}m${text}\x1b[${reset}m`
}

/** Truecolor support, checked once (pi-tui reports the terminal capability). */
const TRUE_COLOR = (() => {
  try {
    return getCapabilities().trueColor
  } catch {
    return false
  }
})()

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '')
  const value = Number.parseInt(cleaned, 16)
  if (cleaned.length !== 6 || Number.isNaN(value)) return [212, 212, 212]
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** Closest xterm 256-color index: the 6x6x6 cube, or the grayscale ramp
 *  when the color is near-neutral (the ramp step for a mean m is
 *  8 + 10k, so the nearest step is k = round((m - 8) / 10)). Exported for
 *  tests; every index is in [16, 255]. */
export function to256([r, g, b]: [number, number, number]): number {
  const ramp = [0, 95, 135, 175, 215, 255]
  const nearest = (v: number): number => {
    let best = 0
    for (let i = 1; i < ramp.length; i += 1) {
      if (Math.abs((ramp[i] ?? 0) - v) < Math.abs((ramp[best] ?? 0) - v)) best = i
    }
    return best
  }
  const cubeIndex = 16 + 36 * nearest(r) + 6 * nearest(g) + nearest(b)
  const mean = Math.round((r + g + b) / 3)
  const cubeDist = Math.abs(r - (ramp[nearest(r)] ?? 0)) + Math.abs(g - (ramp[nearest(g)] ?? 0)) + Math.abs(b - (ramp[nearest(b)] ?? 0))
  const grayDist = Math.abs(r - mean) + Math.abs(g - mean) + Math.abs(b - mean)
  // Clamp to the ramp's last step (255): a near-white gray like #ececec would
  // otherwise map to 256, an invalid SGR index.
  return cubeDist <= grayDist ? cubeIndex : 232 + Math.min(23, Math.max(0, Math.round((mean - 8) / 10)))
}

/** Foreground style for a hex color (truecolor when the terminal supports it). */
function fgHex(hex: string): (text: string) => string {
  const [r, g, b] = hexToRgb(hex)
  return sgr(TRUE_COLOR ? `38;2;${r};${g};${b}` : `38;5;${to256([r, g, b])}`)
}

/** Background style for a hex color. */
function bgHex(hex: string): (text: string) => string {
  const [r, g, b] = hexToRgb(hex)
  return sgr(TRUE_COLOR ? `48;2;${r};${g};${b}` : `48;5;${to256([r, g, b])}`)
}

const bold = sgr('1')
const dim = sgr('2')
const italic = sgr('3')
const underline = sgr('4')
const strikethrough = sgr('9')
const fgGreen = sgr('32')
const fgCyan = sgr('36')
const fgYellow = sgr('33')
const boldCyan = sgr('1;36')
const dimRed = sgr('2;31')

// pi's dark palette (hex values from pi-coding-agent's dark theme).
const piGold = fgHex('#f0c674')
const piTeal = fgHex('#8abeb7')
const piLinkBlue = fgHex('#81a2be')
const piGreen = fgHex('#b5bd68')
const piGray = fgHex('#808080')
const piDimGray = fgHex('#666666')
const piText = fgHex('#d4d4d4')
// The Web UI's Deep diving turn status is the brand blue.
const piBlue = fgHex('#4276e6')

/** Header line: bold bright cyan. */
export function headerStyle(text: string): string {
  return boldCyan(text)
}

/** User transcript rows: green, so your own prompts stand apart from the assistant. */
export function userStyle(text: string): string {
  return fgGreen(text)
}

/** User prompt marker: a green dot in its own column. U+25CF renders in
 *  every terminal font (the earlier U+276F chevron showed as tofu on some
 *  fonts). */
export function userMarker(): string {
  return fgGreen('● ')
}

/** Assistant response marker: a cyan block that prefixes model rows and the
 *  in-flight partial, chat-style. Rendered in its own component so it never
 *  interferes with Markdown parsing (e.g. a leading code fence). */
export function assistantMarker(): string {
  return fgCyan('▍ ')
}

/** Footer hint line: dim. */
export function footerStyle(text: string): string {
  return dim(text)
}

/** Context-usage coloring, mirroring pi's footer: red past 90%, yellow past 70%. */
export function contextStyle(percent: number, text: string): string {
  if (percent > 90) return dimRed(text)
  if (percent > 70) return fgYellow(text)
  return dim(text)
}

/** Picker panel background: dark gray, so the overlay separates from the transcript. */
export const pickerPanelStyle = sgr('48;5;236')

/** User message bubble background (pi's userMessageBg #343541): your prompts
 *  render in a subtle bubble like the pi coding agent. */
export const userBubbleBg = bgHex('#343541')

/** Tool block background (pi's toolPendingBg #282832) for call boxes. */
export const toolBoxBg = bgHex('#282832')

/** Tool result background (pi's toolSuccessBg #283228): a finished result
 *  shifts to the success tint, like the pi coding agent. */
export const toolResultBoxBg = bgHex('#283228')

/** Failed tool result background (pi's toolErrorBg #3c2828). */
export const toolErrorBoxBg = bgHex('#3c2828')

/** Tool title: pi renders the tool name bold in the default text color. */
export const toolTitleStyle = (text: string): string => bold(piText(text))

/** Tool output: pi renders tool results in gray (muted). */
export const toolOutputStyle = (text: string): string => piGray(text)

/** Working status ("Deep diving...", the Web UI's brand blue, bold). */
export const workingStyle = (text: string): string => bold(piBlue(text))

/** Assistant Markdown in pi's dark palette: gold headings, teal code and list
 *  bullets, blue links, green code blocks, gray quotes — readable on the
 *  default terminal background. */
export const markdownTheme: MarkdownTheme = {
  heading: piGold,
  link: (text: string) => underline(piLinkBlue(text)),
  linkUrl: piDimGray,
  code: piTeal,
  codeBlock: piGreen,
  codeBlockBorder: piGray,
  quote: piGray,
  quoteBorder: piGray,
  hr: piGray,
  listBullet: piTeal,
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
    // pi 0.84.2 declares selectedPrefix but renders a hardcoded "→ " prefix;
    // the key is required by the theme type, so provide the styled form for
    // forwards compatibility. Attribute-specific resets keep the panel
    // background alive on rows that carry it.
    selectedPrefix: (text: string) => `\x1b[1;36m${text}\x1b[22;39m`,
    selectedText: boldCyan,
    description: dim,
    scrollInfo: dim,
    noMatch: dimRed,
  },
}
