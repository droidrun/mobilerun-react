// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from 'bun:test';
import { fetchDeviceInfo } from './use-device-stream';

const info = { streamUrl: 'wss://stream.example/ws', streamToken: 'tok', state: 'ready' } as never;

test('fetchDeviceInfo with a client retrieves by device id', async () => {
  const retrieve = mock(async (_id: string) => info);
  const client = { devices: { retrieve } } as never;
  expect(await fetchDeviceInfo({ client, deviceId: 'dev_1' })).toBe(info);
  expect(retrieve).toHaveBeenCalledWith('dev_1');
});

test('fetchDeviceInfo with a device object refreshes that device', async () => {
  const refresh = mock(async () => info);
  expect(await fetchDeviceInfo({ device: { id: 'dev_1', refresh } })).toBe(info);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a device object wins when both sources are given', async () => {
  const retrieve = mock(async () => ({}) as never);
  const refresh = mock(async () => info);
  const client = { devices: { retrieve } } as never;
  await fetchDeviceInfo({ client, deviceId: 'dev_2', device: { id: 'dev_1', refresh } });
  expect(retrieve).not.toHaveBeenCalled();
});

// Minimal hook runner: effects re-run only when their deps change between renders.
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
          let cursor = 0; const slots = [];
          export function useRef(v) { return slots[cursor++] ??= { current: v }; }
          export function useState(v) { const r = useRef(v); return [r.current, n => { r.current = typeof n === 'function' ? n(r.current) : n; }]; }
          export function useCallback(fn) { return fn; }
          export function useEffect(fn, deps) {
            const r = useRef(undefined);
            if (r.current && deps.every((d, i) => Object.is(d, r.current.deps[i]))) return;
            r.current?.cleanup?.();
            r.current = { deps, cleanup: undefined };
            const slot = r.current;
            globalThis.pending.push(() => { slot.cleanup = fn(); });
          }
          globalThis.resetCursor = () => { cursor = 0; };
        `,
      }));
    },
  }],
});
const mod: { exports: { useDeviceStream: (o: unknown) => unknown } } = { exports: {} as never };
const g = globalThis as unknown as { pending: (() => void)[]; resetCursor: () => void };
g.pending = [];
new Function('module', 'exports', await bundle.outputs[0].text())(mod, mod.exports);

test('a fresh device handle with the same id does not refetch on rerender', async () => {
  const refresh = mock(async () => info);
  const render = () => {
    g.resetCursor();
    mod.exports.useDeviceStream({ device: { id: 'dev_1', refresh: () => refresh() }, pollIntervalMs: 0 });
    for (const run of g.pending.splice(0)) run();
  };
  render();
  render();
  render();
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(1);
});
