// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import type { UseDeviceStreamOptions } from './use-device-stream';

// Type-only check: extending the legacy options interface keeps compiling.
export interface PanelOptions extends UseDeviceStreamOptions {
  label: string;
}

// Isolate the hook per test run without a DOM dependency. Effects re-run only
// when their deps change between renders; cleanup runs before the next setup.
const bundle = await Bun.build({
  entrypoints: [import.meta.dir + '/use-device-stream.ts'],
  target: 'browser',
  format: 'cjs',
  plugins: [{
    name: 'hook-runner',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        loader: 'js',
        contents: `
          let cursor = 0;
          const slots = [];
          export function useRef(value) { return slots[cursor++] ??= { current: value }; }
          export function useState(value) {
            const ref = useRef(value);
            const set = next => {
              ref.current = typeof next === 'function' ? next(ref.current) : next;
            };
            return [ref.current, set];
          }
          export function useCallback(fn) { return fn; }
          export function useEffect(fn, deps) {
            const ref = useRef(undefined);
            const same = ref.current && deps.every((d, i) => Object.is(d, ref.current.deps[i]));
            if (same) return;
            ref.current?.cleanup?.();
            const slot = ref.current = { deps, cleanup: undefined };
            pending.push(() => { slot.cleanup = fn(); });
          }
          globalThis.beginRender = () => { cursor = 0; };
        `,
      }));
    },
  }],
});
if (!bundle.success) throw new Error('Could not bundle hook fixture', { cause: bundle.logs });
const code = await bundle.outputs[0].text();

function harness() {
  const pending: (() => void)[] = [];
  const module = { exports: {} as { useDeviceStream: (options: unknown) => unknown } };
  const context: Record<string, unknown> = { pending, module, exports: module.exports, setTimeout, clearTimeout };
  runInNewContext(code, context);
  const render = (options: unknown) => {
    (context.beginRender as () => void)();
    module.exports.useDeviceStream(options);
    for (const run of pending.splice(0)) run();
  };
  return { render };
}

const info = { streamUrl: 'wss://stream.example/ws', streamToken: 'tok', state: 'ready' };
const noStream = { state: 'booting' };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('a fresh device handle with the same id does not refetch on rerender', async () => {
  const refresh = mock(async () => info);
  const { render } = harness();
  for (let i = 0; i < 3; i++) render({ device: { id: 'dev_1', refresh }, pollIntervalMs: 0 });
  await tick();
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a client and device id fetch once across rerenders', async () => {
  const retrieve = mock(async (_id: string) => info);
  const client = { devices: { retrieve } };
  const { render } = harness();
  render({ client, deviceId: 'dev_1', pollIntervalMs: 0 });
  render({ client, deviceId: 'dev_1', pollIntervalMs: 0 });
  await tick();
  expect(retrieve).toHaveBeenCalledTimes(1);
  expect(retrieve).toHaveBeenCalledWith('dev_1');
});

test('changing the device id refreshes the new handle and cancels the old poll', async () => {
  const oldRefresh = mock(async () => noStream);
  const newRefresh = mock(async () => info);
  const { render } = harness();
  render({ device: { id: 'dev_1', refresh: oldRefresh }, pollIntervalMs: 20 });
  await tick();
  render({ device: { id: 'dev_2', refresh: newRefresh }, pollIntervalMs: 20 });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(newRefresh).toHaveBeenCalledTimes(1);
  expect(oldRefresh).toHaveBeenCalledTimes(1);
});
