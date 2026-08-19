/**
 * theme.ts tests: the 256-color fallback matcher stays in range and picks the
 * closest gray step, so a terminal without truecolor never receives an
 * invalid SGR index.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { to256, composerBorderStyle, promptStyle, questionBoxBg, toolDisplayName, toolDotStyle, toolErrorBoxBg, toolOutputStyle, toolResultBoxBg, toolResultStyle, toolTitleStyle, userBubbleBg, userStyle } from '../src/theme.js'

test('theme resets are attribute-specific so box backgrounds survive', () => {
  // pi's Box wraps each padded row in the background style; a full \x1b[0m
  // inside a styled token would kill the row's background for everything
  // after it. Every style must reset only the attribute it sets. The byte
  // form of color styles depends on the terminal's truecolor support, so
  // assert the structure (set code + matching reset) instead of exact bytes.
  const bubble = userBubbleBg('x')
  assert.ok(bubble.startsWith('\x1b[48;') && bubble.endsWith('\x1b[49m'), bubble)
  const output = toolOutputStyle('x')
  assert.ok(output.startsWith('\x1b[38;') && output.endsWith('\x1b[39m'), output)
  // Foreground styles reset only the foreground, in either color mode.
  const user = userStyle('x')
  assert.ok(user.startsWith('\x1b[38;') && user.endsWith('\x1b[39m'), user)
  const title = toolTitleStyle('x')
  assert.ok(title.includes('\x1b[39m') && title.endsWith('\x1b[22m'), title)
  // The composer prompt is a foreground style with only its attribute reset.
  const prompt = promptStyle('> ')
  assert.ok(prompt.startsWith('\x1b[38;') && prompt.endsWith('\x1b[39m'), prompt)
  // The tool result text is a NEUTRAL grey: equal RGB channels (truecolor)
  // or the 256-ramp step 249, so no channel can read greenish. The composer
  // border style is a foreground accent.
  const resultText = toolResultStyle('x')
  assert.ok(resultText.startsWith('\x1b[38;') && resultText.endsWith('\x1b[39m'), resultText)
  const rgb = resultText.match(/38;2;(\d+);(\d+);(\d+)/)
  if (rgb !== null) {
    assert.equal(rgb[1], rgb[2], 'red == green')
    assert.equal(rgb[2], rgb[3], 'green == blue')
  } else {
    assert.match(resultText, /38;5;249/, '256-ramp neutral grey')
  }
  assert.ok(composerBorderStyle('─').endsWith('\x1b[39m'), 'composer border is a foreground style')
  // No full reset may appear anywhere in a styled token.
  for (const style of [userBubbleBg, promptStyle, toolOutputStyle, toolResultStyle, userStyle, toolTitleStyle]) {
    assert.ok(!style('x').includes('\x1b[0m'), 'style must not contain a full reset')
  }
})

test('to256 cube path maps the palette hexes to their xterm cube indices', () => {
  // Cube picks verified against xterm's 6x6x6 cube: f0c674 -> 222,
  // 8abeb7 -> 109, b5bd68 -> 143, 81a2be -> 109.
  assert.equal(to256([0xf0, 0xc6, 0x74]), 222)
  assert.equal(to256([0x8a, 0xbe, 0xb7]), 109)
  assert.equal(to256([0xb5, 0xbd, 0x68]), 143)
  assert.equal(to256([0x81, 0xa2, 0xbe]), 109)
})

test('the 256-color fallbacks are distinct and brightness-ordered', () => {
  // In 256-color mode each surface must emit its explicit index; in
  // truecolor mode the byte form is 48;2;r;g;b and there is nothing to pin.
  const fallback = (style: (text: string) => string, expected: number): void => {
    const out = style('x')
    const match = out.match(/48;5;(\d+)/)
    if (match !== null) assert.equal(Number(match[1]), expected, out)
    else assert.ok(out.startsWith('\x1b[48;2;'), out)
  }
  fallback(userBubbleBg, 236)
  fallback(toolResultBoxBg, 237)
  fallback(toolErrorBoxBg, 238)
  fallback(questionBoxBg, 239)
})

test('tool display names capitalize like the reference and dots stay clean', () => {
  assert.equal(toolDisplayName('bash'), 'Bash')
  assert.equal(toolDisplayName('run_code'), 'RunCode')
  assert.equal(toolDisplayName('web_search'), 'WebSearch')
  assert.equal(toolDisplayName('weird_tool'), 'Weird_tool')
  assert.equal(toolDisplayName(''), '')
  // The dot style resets only the foreground, whatever the color mode.
  for (const name of ['bash', 'read', 'write', 'web_search', 'subagent', 'unknown']) {
    const dot = toolDotStyle(name, false)('•')
    assert.ok(dot.startsWith('\x1b[38;') && dot.endsWith('\x1b[39m'), `${name}: ${dot}`)
    assert.ok(!dot.includes('\x1b[0m'), `${name} has no full reset`)
  }
  const err = toolDotStyle('bash', true)('✗')
  assert.ok(err.startsWith('\x1b[38;') && err.endsWith('\x1b[39m'), err)
})

test('to256 gray ramp picks the nearest step and never exceeds 255', () => {
  // Ramp steps are 8 + 10k at indices 232..255. #8d95a6 (mean 152) -> 232+14.
  assert.equal(to256([0x8d, 0x95, 0xa6]), 246)
  // #e8e6e0 (mean 229) -> nearest step 228 -> 254.
  assert.equal(to256([0xe8, 0xe6, 0xe0]), 254)
  // #292d36 (mean 46) -> gray 236 (step 48).
  assert.equal(to256([0x29, 0x2d, 0x36]), 236)
  // #3a3a3a (mean 58) -> gray 237.
  assert.equal(to256([0x3a, 0x3a, 0x3a]), 237)
  // Near-white grays clamp to the last ramp step (255) instead of 256.
  assert.equal(to256([0xec, 0xec, 0xec]), 255)
  // Pure white and black are exact cube cells (231, 16) — the cube branch wins
  // the tie, and both indices are valid.
  assert.equal(to256([0xff, 0xff, 0xff]), 231)
  assert.equal(to256([0, 0, 0]), 16)
  // Every palette gray stays within the valid SGR range.
  for (const hex of [0x292d36, 0x3a3a3a, 0x362b2c, 0x30353d, 0x5e6673, 0x8d95a6, 0xb0b0b0, 0xe8e6e0]) {
    const index = to256([(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff])
    assert.ok(index >= 16 && index <= 255, `index ${index} out of range for #${hex.toString(16)}`)
  }
})
