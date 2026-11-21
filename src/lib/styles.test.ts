// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The host's own theme names the stylesheet reads as a fallback; it must not declare them.
const LEGACY_HOST_TOKENS = [
  'background', 'foreground', 'card', 'card-foreground', 'muted', 'muted-foreground', 'border', 'ring',
  'primary', 'primary-foreground', 'accent', 'accent-foreground', 'destructive',
];

async function compileStylesheet(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mobilerun-css-'));
  try {
    const root = join(import.meta.dir, '..', '..');
    const out = join(dir, 'styles.css');
    const proc = Bun.spawn([join(root, 'node_modules/.bin/tailwindcss'), '-i', join(root, 'src/styles.css'), '-o', out, '--minify'], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the stylesheet declares no custom property on :root, :host or a bare .dark', async () => {
  const css = await compileStylesheet();
  expect(css).not.toContain(':root');
  expect(css).not.toContain(':host');
  expect(css).not.toMatch(/(^|\})\.dark\{/);
  // Nothing generic such as --background, --spacing or --text-xs is declared at all.
  const declared = [...css.matchAll(/(?:^|[{;])(--[a-z0-9-]+):/g)].map((m) => m[1]);
  expect(declared.filter((name) => !name.startsWith('--tw-') && !name.startsWith('--mr-'))).toEqual([]);
  // source(none) must not have dropped the utilities the components use.
  for (const selector of ['.animate-spin', '.bg-background', '.slide-in-from-bottom-\\[1\\.5rem\\]', '.md\\:hidden', '.rc-video']) {
    expect(css).toContain(selector);
  }
});

test('every variable the stylesheet reads is either its own, prefixed, or a documented host token', async () => {
  const css = await compileStylesheet();
  const declared = new Set([...css.matchAll(/(?:^|[{;])(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const read = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  const orphans = read.filter(
    (name) => !declared.has(name) && !name.startsWith('--mr-') && !LEGACY_HOST_TOKENS.includes(name.slice(2)) && !name.startsWith('--tw-'),
  );
  expect(orphans).toEqual([]);
});
