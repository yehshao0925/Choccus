/**
 * Determinism-hostile token guard: a cheap backstop in case the ESLint
 * `no-restricted-properties` config for client/src/sim/** ever drifts.
 * Scans source with COMMENTS STRIPPED (see stripComments): the guard targets
 * actual CALLS/uses of the banned APIs — a banned name mentioned inside a
 * determinism note (e.g. "NO Math.random / Date.now") is harmless and must not
 * trip the check. ESLint's no-restricted-properties stays the primary guard.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CLIENT_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'client',
  'src',
);
const SIM_DIR = join(CLIENT_SRC, 'sim');
const AI_DIR = join(CLIENT_SRC, 'ai');

const BANNED = [
  'Date.now',
  'Math.random',
  'performance.now',
  'Math.sin',
  'Math.cos',
  'Math.sqrt',
];

/**
 * Strip TS block and line comments before scanning so a banned name that only
 * appears in a comment cannot trip the guard. Block comments are removed first
 * (so a slash-slash inside a block comment is not mistaken for a line comment).
 * The line pattern keeps a preceding non-colon char, so a "://" inside a string
 * (e.g. a URL) is preserved. An obfuscated call that splices a block comment
 * into a token collapses back to the bare token and is still caught.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Scan every .ts under `dir` for the BANNED determinism-hostile tokens. */
function scanDir(label: string, dir: string, minFiles: number): void {
  describe(`determinism-hostile tokens are absent from ${label}`, () => {
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'));

    it(`finds the ${label} sources`, () => {
      expect(files.length).toBeGreaterThanOrEqual(minFiles);
    });

    for (const file of files) {
      it(`${file} contains no banned token`, () => {
        const text = stripComments(readFileSync(join(dir, file), 'utf8'));
        for (const token of BANNED) {
          expect(
            text.includes(token),
            `${file} contains banned token "${token}"`,
          ).toBe(false);
        }
      });
    }
  });
}

// Keep the original sim scan; ALSO scan the AI modules (v2 forward-search bot:
// BotController + commitment/forwardSearch/scenarios/dangerMap/grid/etc.).
scanDir('client/src/sim', SIM_DIR, 10);
scanDir('client/src/ai', AI_DIR, 5);
