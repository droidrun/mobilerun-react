// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from 'bun:test';
import { runHook, tick } from './test-hook-runner';
import type { UseDeviceStreamOptions, UseDeviceStreamResult } from './use-device-stream';

// Type-only check: extending the legacy options interface keeps compiling.
export interface PanelOptions extends UseDeviceStreamOptions {
  label: string;
}

async function harness() {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const runner = await runHook<{ useDeviceStream: (options: unknown) => UseDeviceStreamResult }>(
    import.meta.dir + '/use-device-stream.ts',
    {
      setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
  );
  const render = (options: unknown) => {
    runner.beginRender();
    const result = runner.module.exports.useDeviceStream(options);
    runner.flushEffects();
    return result;
  };
  return {
    render, unmount: runner.unmount, timers,
    fireTimers() {
      const tasks = [...timers.values()];
      timers.clear();
      tasks.forEach(fn => fn());
    },
  };
}

const info = { streamUrl: 'wss://stream.example/ws', streamToken: 'tok', state: 'ready' };
const noStream = { state: 'booting' };

test('a fresh device handle with the same id does not refetch on rerender', async () => {
  const refresh = mock(async () => info);
  const { render } = await harness();
  for (let i = 0; i < 3; i++) render({ device: { id: 'dev_1', refresh }, pollIntervalMs: 0 });
  await tick();
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a client and device id fetch once across rerenders', async () => {
  const retrieve = mock(async (_id: string) => info);
  const client = { devices: { retrieve } };
  const { render } = await harness();
  render({ client, deviceId: 'dev_1', pollIntervalMs: 0 });
  render({ client, deviceId: 'dev_1', pollIntervalMs: 0 });
  await tick();
  expect(retrieve).toHaveBeenCalledTimes(1);
  expect(retrieve).toHaveBeenCalledWith('dev_1');
});

test('changing the device id refreshes the new handle and cancels the old poll', async () => {
  const oldRefresh = mock(async () => noStream);
  const newRefresh = mock(async () => info);
  const { render, fireTimers } = await harness();
  render({ device: { id: 'dev_1', refresh: oldRefresh }, pollIntervalMs: 20 });
  await tick();
  render({ device: { id: 'dev_2', refresh: newRefresh }, pollIntervalMs: 20 });
  await tick();
  fireTimers();
  await tick();
  expect(newRefresh).toHaveBeenCalledTimes(1);
  expect(oldRefresh).toHaveBeenCalledTimes(1);
});

test('a failed initial fetch retries, clears its error on success, and stops polling', async () => {
  const failure = new Error('temporary failure');
  const refresh = mock(async () => {
    if (refresh.mock.calls.length === 1) throw failure;
    return info;
  });
  const { render, unmount, fireTimers, timers } = await harness();
  const options = { device: { id: 'dev_1', refresh }, pollIntervalMs: 20 };
  render(options);
  await tick();
  expect(render(options).error).toBe(failure);
  fireTimers();
  await tick();
  const result = render(options);
  expect(result.error).toBeUndefined();
  expect(result.streamUrl).toBe(info.streamUrl);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(timers.size).toBe(0);
  fireTimers();
  await tick();
  expect(refresh).toHaveBeenCalledTimes(2);
  unmount();
});

for (const end of ['unmount', 'disable', 'id change'] as const) {
  test(`a failed fetch does not keep polling after ${end}`, async () => {
    const refresh = mock(async () => { throw new Error('temporary failure'); });
    const { render, unmount, fireTimers, timers } = await harness();
    const options = { device: { id: 'dev_1', refresh }, pollIntervalMs: 20 };
    render(options);
    await tick();
    if (end === 'unmount') unmount();
    else if (end === 'disable') render({ ...options, enabled: false });
    else render({ ...options, device: { id: 'dev_2', refresh: async () => info } });
    expect(timers.size).toBe(0);
    fireTimers();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
  });
}

test('a permanent 404 failure keeps the error without retrying', async () => {
  const failure = { status: 404, message: 'device not found' };
  const refresh = mock(async () => { throw failure; });
  const { render, unmount, fireTimers, timers } = await harness();
  const options = { device: { id: 'dev_1', refresh }, pollIntervalMs: 20 };
  render(options);
  await tick();
  expect(render(options).error).toBe(failure);
  expect(timers.size).toBe(0);
  fireTimers();
  await tick();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(render(options).error).toBe(failure);
  unmount();
});

for (const status of [408, 429, 503]) {
  test(`a transient ${status} failure retries`, async () => {
    const failure = { status };
    const refresh = mock(async () => {
      if (refresh.mock.calls.length === 1) throw failure;
      return info;
    });
    const { render, unmount, fireTimers, timers } = await harness();
    const options = { device: { id: 'dev_1', refresh }, pollIntervalMs: 20 };
    render(options);
    await tick();
    expect(render(options).error).toBe(failure);
    expect(timers.size).toBe(1);
    fireTimers();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(render(options).error).toBeUndefined();
    expect(timers.size).toBe(0);
    unmount();
  });
}
