// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', 'conformance', 'fixtures');

/** Read a vendored conformance fixture (JSON keeps lone surrogates intact). */
export function loadFixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

export function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fail when a fixture directory holds a file no test claims, so a file added by
 * a later release cannot be silently ignored.
 */
export function expectAllFixturesUsed(dir: string, used: string[]): void {
  const files = readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  if (JSON.stringify(files) !== JSON.stringify([...used].sort())) {
    throw new Error(`fixtures in ${dir}/ changed: found [${files}], tests cover [${[...used].sort()}]`);
  }
}
