// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test';
import { runHook } from './test-hook-runner';

async function harness() {
  const warnings: string[] = [];
  const runner = await runHook<{ useStaticTokenWarning: (using: boolean) => void }>(
    import.meta.dir + '/use-static-token-warning.ts',
    { console: { warn: (message: string) => warnings.push(message) } },
  );
  const render = (using: boolean) => {
    runner.beginRender();
    runner.module.exports.useStaticTokenWarning(using);
    runner.flushEffects();
  };
  return { warnings, render };
}

test('a static key warns once per mount, however often it re-renders', async () => {
  const { warnings, render } = await harness();
  render(true);
  render(true);
  render(true);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('tokenProvider');
});

test('no warning while a provider is in use', async () => {
  const { warnings, render } = await harness();
  render(false);
  render(false);
  expect(warnings).toEqual([]);
});
