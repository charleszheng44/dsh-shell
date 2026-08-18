/**
 * theme.ts tests: the 256-color fallback matcher stays in range and picks the
 * closest gray step, so a terminal without truecolor never receives an
 * invalid SGR index.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { to256 } from '../src/theme.js'

test('to256 cube path maps the palette hexes to their xterm cube indices', () => {
  // Cube picks verified against xterm's 6x6x6 cube: f0c674 -> 222,
  // 8abeb7 -> 109, b5bd68 -> 143, 81a2be -> 109.
  assert.equal(to256([0xf0, 0xc6, 0x74]), 222)
  assert.equal(to256([0x8a, 0xbe, 0xb7]), 109)
  assert.equal(to256([0xb5, 0xbd, 0x68]), 143)
  assert.equal(to256([0x81, 0xa2, 0xbe]), 109)
})

test('to256 gray ramp picks the nearest step and never exceeds 255', () => {
  // Ramp steps are 8 + 10k at indices 232..255. #808080 (128) -> step 128 -> 244.
  assert.equal(to256([0x80, 0x80, 0x80]), 244)
  // #d4d4d4 (212) -> nearest step 208 -> 252.
  assert.equal(to256([0xd4, 0xd4, 0xd4]), 252)
  // #343541 (mean 57, near-neutral) -> gray 237 (step 58).
  assert.equal(to256([0x34, 0x35, 0x41]), 237)
  // #282832 (mean 43) -> gray 236 (step 48).
  assert.equal(to256([0x28, 0x28, 0x32]), 236)
  // Near-white grays clamp to the last ramp step (255) instead of 256.
  assert.equal(to256([0xec, 0xec, 0xec]), 255)
  // Pure white and black are exact cube cells (231, 16) — the cube branch wins
  // the tie, and both indices are valid.
  assert.equal(to256([0xff, 0xff, 0xff]), 231)
  assert.equal(to256([0, 0, 0]), 16)
  // Every palette gray stays within the valid SGR range.
  for (const hex of [0x343541, 0x282832, 0x808080, 0xd4d4d4, 0x666666, 0x283228]) {
    const index = to256([(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff])
    assert.ok(index >= 16 && index <= 255, `index ${index} out of range for #${hex.toString(16)}`)
  }
})
