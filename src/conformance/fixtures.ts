// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', 'conformance', 'fixtures');

/** Read a vendored conformance fixture (JSON keeps lone surrogates intact). */
export function loadFixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

export function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
