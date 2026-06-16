/**
 * Determinism-hostile token guard: a cheap backstop in case the ESLint
 * `no-restricted-properties` config for client/src/sim/** ever drifts.
 * Scans raw source text (comments included — keep banned names out of sim
 * comments too; the noise is worth the safety).
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
        const text = readFileSync(join(dir, file), 'utf8');
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
