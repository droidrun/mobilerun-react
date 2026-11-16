// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import type { UseTaskApprovalOptions } from './use-task-approval';
import { runHook, tick } from './test-hook-runner';

async function setup(options: Partial<UseTaskApprovalOptions>) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const setTimer = (fn: () => void, ms: number) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; };
  const clearTimer = (id: number) => { timers.delete(id); };
  const runner = await runHook<{ useTaskApproval: (o: UseTaskApprovalOptions) => unknown }>(
    import.meta.dir + '/use-task-approval.ts', { setTimeout: setTimer, clearTimeout: clearTimer },
  );
  const errors: unknown[] = [];
  let fetches = 0;
  runner.beginRender();
  runner.module.exports.useTaskApproval({
    taskId: 't1',
    fetchApproval: async () => { fetches++; return null; },
    decide: async () => {},
    onError: (e) => errors.push(e),
    ...options,
  });
  runner.flushEffects();
  await tick();
  return {
    errors, timers,
    get fetches() { return fetches; },
    // Runs the pending poll timer, like the clock reaching it.
    async fire() { const [id, t] = [...timers][0]; timers.delete(id); t.fn(); await tick(); },
    unmount: runner.unmount,
  };
}

const failing = () => { throw new Error('stream down'); };

describe('subscribe failure', () => {
  test('is reported once and polling starts at 3 s', async () => {
    const f = await setup({ subscribe: failing });
    expect(f.errors).toHaveLength(1);
    expect((f.errors[0] as Error).message).toBe('stream down');
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([3000]);
    await f.fire();
    expect(f.fetches).toBe(2);
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([3000]);
    expect(f.errors).toHaveLength(1);
    f.unmount();
  });

  test('polls at the given interval', async () => {
    const f = await setup({ subscribe: failing, pollIntervalMs: 500 });
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([500]);
    f.unmount();
  });

  test('polls at 3 s even when 0 was given, since 0 only means "no polling" while subscribe works', async () => {
    const f = await setup({ subscribe: failing, pollIntervalMs: 0 });
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([3000]);
    f.unmount();
  });
});

describe('working subscribe', () => {
  test('does not poll by default or with an explicit 0', async () => {
    for (const pollIntervalMs of [undefined, 0]) {
      const f = await setup({ subscribe: () => () => {}, pollIntervalMs });
      expect(f.timers.size).toBe(0);
      expect(f.errors).toEqual([]);
      f.unmount();
    }
  });

  test('without subscribe the default is 3 s', async () => {
    const f = await setup({});
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([3000]);
    f.unmount();
  });
});

describe('subscribe failure with a synchronously throwing fetch', () => {
  test('still arms the fallback poll, and firing it fetches again', async () => {
    let attempts = 0;
    const f = await setup({
      subscribe: failing,
      fetchApproval: () => { attempts++; throw new Error('fetch down'); },
    });
    expect(attempts).toBe(1);
    expect(f.errors.map((e) => (e as Error).message)).toEqual(['stream down', 'fetch down']);
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([3000]);
    await f.fire();
    expect(attempts).toBe(2);
    f.unmount();
  });
});
