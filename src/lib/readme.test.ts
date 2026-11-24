// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readme = readFileSync(join(import.meta.dir, '..', '..', 'README.md'), 'utf8');

// npmjs.com renders the README without the repository tree, so a relative target is a dead link there.
test('every README link and image target is absolute', () => {
  const targets = [
    ...[...readme.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...readme.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1]),
  ];
  expect(targets.length).toBeGreaterThan(10);
  expect(targets.filter((t) => !/^(https?:\/\/|#|mailto:)/.test(t))).toEqual([]);
});

test('the README names the --mr-* variables and the fallback order', () => {
  expect(readme).toContain('--mr-background');
  expect(readme).toContain('--mr-primary');
  expect(readme).toMatch(/`--mr-<name>`, then the old unprefixed `--<name>`.*then the bundled\s+default/s);
});
