/**
 * Terminal color theme: ANSI SGR styling for every pi-tui component the TUI
 * renders, aligned with the Gentle Mist Blue (雾蓝) dark palette of the
 * dsh-TUI reference client (warm off-white text, mist blues for brand and
 * interaction, warm tan headings, sage code blocks, mist rose/amber status
 * colors, and bubble/card surfaces with their own backgrounds). Theme
 * functions wrap text in attribute-specific color codes (each resets only
 * what it sets, so styles never bleed and box backgrounds survive); the
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

/** Background style for a hex color. The 256-color branch may take an explicit
 *  fallback index for colors whose nearest index collides with a sibling's. */
function bgHex(hex: string, fallback256?: number): (text: string) => string {
  const [r, g, b] = hexToRgb(hex)
  return sgr(TRUE_COLOR ? `48;2;${r};${g};${b}` : `48;5;${fallback256 ?? to256([r, g, b])}`)
}

const bold = sgr('1')
const dim = sgr('2')
const italic = sgr('3')
const underline = sgr('4')
const strikethrough = sgr('9')
// The Gentle Mist Blue (雾蓝) dark palette, from the dsh-TUI reference
// client: warm off-white text, mist blues for brand and interaction, soft
// rose/amber/green for status. Kept for the 256-color fallbacks in bgHex.
const mistText = fgHex('#e8e6e0')
const mistBlue = fgHex('#7da1de')
const mistShimmer = fgHex('#abc2ec')
const mistAccentBlue = fgHex('#5e88cc')
const mistSubtle = fgHex('#5e6673')
const mistInactive = fgHex('#8d95a6')
const mistSage = fgHex('#9fbf8f')
const mistWarmTan = fgHex('#d9a97e')
const mistRose = fgHex('#da8a93')
const mistAmber = fgHex('#d8b270')
const mistGreen = fgHex('#82b89d')

/** Header line: bold in the reference's interaction blue (remember). */
export function headerStyle(text: string): string {
  return bold(mistShimmer(text))
}

/** User transcript rows: warm off-white, like the reference's user prompt text. */
export function userStyle(text: string): string {
  return mistText(text)
}

/** User prompt marker: the reference's right chevron in the subtle gray. */
export function userMarker(): string {
  return mistSubtle('❯ ')
}

/** Assistant response marker: a mist-blue block that prefixes model rows and
 *  the in-flight partial, chat-style. Rendered in its own component so it
 *  never interferes with Markdown parsing (e.g. a leading code fence). */
export function assistantMarker(): string {
  return mistBlue('▍ ')
}

/** Footer hint line: dim. */
export function footerStyle(text: string): string {
  return dim(text)
}

/** Context-usage coloring: the reference's amber past 70%, rose past 90%. */
export function contextStyle(percent: number, text: string): string {
  if (percent > 90) return mistRose(text)
  if (percent > 70) return mistAmber(text)
  return dim(text)
}

/** Picker panel background: the 256-color index 236 (the bubble-family
 *  step), so the overlay separates from the transcript. */
export const pickerPanelStyle = sgr('48;5;236')

/** Picker title: bold in the reference's interaction blue (suggestion). */
export const pickerTitleStyle = (text: string): string => bold(mistShimmer(text))

/** User message bubble background (the reference's userMessageBackground
 *  #292D36); its natural 256-color index (236) mirrors the truecolor hex. */
export const userBubbleBg = bgHex('#292d36')

/** Question card background (the reference's memoryBackgroundColor #30353D):
 *  a host question renders as its own boxed card at the transcript tail. */
export const questionBoxBg = bgHex('#30353d', 239)

/** Tool title: bold in the warm off-white text color. */
export const toolTitleStyle = (text: string): string => bold(mistText(text))

/** Tool output: the reference's subtle blue-gray (muted). */
export const toolOutputStyle = (text: string): string => mistSubtle(text)

/** Thinking chain: the model's reasoning in the subtle blue-gray, italic. */
export const reasoningStyle = (text: string): string => italic(mistSubtle(text))

/** Tool result text: neutral light grey, Codex-style — the reference's
 *  blue-gray (#5e6673) has green above red and can read as greenish-grey on
 *  the canvas; the output block should be grey on grey. */
export const toolResultStyle = (text: string): string => fgHex('#b0b0b0')(text)

/** Composer box border: the reference's accent blue, drawn as full-width
 *  rules above and below the editor (the editor blanks its own border rows
 *  so the "> " prefix cannot open the box at the left). */
export const composerBorderStyle = (text: string): string => mistAccentBlue(text)

/** Working status ("Deep diving...", the reference's mist brand blue, bold). */
export const workingStyle = (text: string): string => bold(mistBlue(text))

/** Tool display names: the reference maps lowercase tool ids to capitalized
 *  names (bash → Bash); unknown ids get their first letter uppercased. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: 'Bash',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  search: 'Search',
  file_search: 'FileSearch',
  write: 'Write',
  edit: 'Edit',
  run_code: 'RunCode',
  todo_write: 'TodoWrite',
  subagent: 'Task',
  task: 'Task',
  job: 'Job',
  workflow: 'Workflow',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  browser: 'Browser',
}

export function toolDisplayName(name: string): string {
  const mapped = TOOL_DISPLAY_NAMES[name]
  if (mapped !== undefined) return mapped
  if (name.length === 0) return name
  return name[0]?.toUpperCase() + name.slice(1)
}

/** Tool category colors for the status dot, from the reference's palette:
 *  exec sage, read cyan, write violet, web mist blue, task rose. */
type ToolCategory = 'exec' | 'read' | 'write' | 'web' | 'task' | 'default'

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  bash: 'exec', powershell: 'exec', pwsh: 'exec', run_code: 'exec',
  read: 'read', grep: 'read', glob: 'read', search: 'read', file_search: 'read',
  write: 'write', edit: 'write', str_replace_editor: 'write', multiedit: 'write',
  web_search: 'web', web_fetch: 'web', browser: 'web',
  subagent: 'task', task: 'task', job: 'task', workflow: 'task',
}

const TOOL_DOT_COLOR: Record<ToolCategory, (text: string) => string> = {
  exec: fgHex('#7fae99'),
  read: fgHex('#82b8c7'),
  write: fgHex('#b3a0d4'),
  web: fgHex('#7da1de'),
  task: fgHex('#d194ae'),
  default: mistGreen,
}

/** The settled tool-status dot in the category color; failures render the
 *  rose cross instead. */
export function toolDotStyle(name: string, error: boolean): (text: string) => string {
  if (error) return mistRose
  return TOOL_DOT_COLOR[TOOL_CATEGORY[name] ?? 'default']
}

/** Assistant Markdown in the Gentle Mist Blue palette: warm tan headings,
 *  mist-blue code and bullets, shimmer-blue links, sage code blocks, subtle
 *  quotes — readable on the default terminal background. */
export const markdownTheme: MarkdownTheme = {
  heading: mistWarmTan,
  link: (text: string) => underline(mistShimmer(text)),
  linkUrl: mistInactive,
  code: mistBlue,
  codeBlock: mistSage,
  codeBlockBorder: mistSubtle,
  quote: mistSubtle,
  quoteBorder: mistSubtle,
  hr: mistSubtle,
  listBullet: mistBlue,
  bold,
  italic,
  strikethrough,
  underline,
}

/** Editor (mist accent border — the composer's prompt column supplies the
 *  border corners so the box's top and bottom lines span the terminal) and
 *  the picker SelectList (mist selection, dim descriptions and scroll info). */
export const editorTheme: EditorTheme = {
  borderColor: mistAccentBlue,
  selectList: {
    // pi 0.84.2 declares selectedPrefix but renders a hardcoded "→ " prefix;
    // the key is required by the theme type, so provide the styled form for
    // forwards compatibility. Attribute-specific resets keep the panel
    // background alive on rows that carry it.
    selectedPrefix: (text: string) => bold(mistShimmer(text)),
    selectedText: (text: string) => bold(mistShimmer(text)),
    description: dim,
    scrollInfo: dim,
    noMatch: mistRose,
  },
}
