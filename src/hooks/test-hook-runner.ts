// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { runInNewContext } from 'node:vm';

const fixtureSource = `
  let cursor = 0;
  const slots = [];
  const effectSlots = new Set();
  export function useRef(value) { return slots[cursor++] ??= { current: value }; }
  export function useState(value) {
    const ref = slots[cursor] ?? { current: typeof value === 'function' ? value() : value };
    slots[cursor++] = ref;
    return [ref.current, next => {
      ref.current = typeof next === 'function' ? next(ref.current) : next;
      stateWrites.push(ref.current);
    }];
  }
  export function useCallback(fn) { return fn; }
  export function useEffect(fn, deps) {
    const ref = useRef(undefined);
    effectSlots.add(ref);
    const same = compareEffectDeps && ref.current && deps &&
      deps.length === ref.current.deps?.length &&
      deps.every((d, i) => Object.is(d, ref.current.deps[i]));
    if (same) return;
    ref.current?.cleanup?.();
    const slot = ref.current = { deps, cleanup: undefined };
    pending.push(() => { slot.cleanup = fn(); });
  }
  export const useLayoutEffect = useEffect;
  globalThis.beginRender = () => { cursor = 0; };
  globalThis.cleanupEffects = () => {
    for (const ref of effectSlots) {
      ref.current?.cleanup?.();
      ref.current = undefined;
    }
  };
`;

/** Let queued promise continuations run. */
export const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const bundles = new Map<string, Promise<string>>();

async function bundleHook(entry: string): Promise<string> {
  const bundle = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'cjs',
    plugins: [{
      name: 'hook-runner',
      setup(build) {
        build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: fixtureSource }));
      },
    }],
  });
  if (!bundle.success) throw new Error('Could not bundle hook fixture', { cause: bundle.logs });
  return bundle.outputs[0].text();
}

/** Bundle once per entry, then isolate module state and effect controls per run. */
export async function runHook<T>(
  entry: string,
  globals: Record<string, unknown> = {},
  { compareEffectDeps = true } = {},
) {
  let code = bundles.get(entry);
  if (!code) {
    code = bundleHook(entry);
    bundles.set(entry, code);
  }
  const pending: (() => void)[] = [];
  const module = { exports: {} as T };
  const context = {
    setTimeout, clearTimeout, stateWrites: [] as unknown[], ...globals,
    module, exports: module.exports, pending, compareEffectDeps,
    beginRender: () => {}, cleanupEffects: () => {},
  };
  runInNewContext(await code, context);
  return {
    module,
    beginRender: () => context.beginRender(),
    flushEffects: () => { for (const run of pending.splice(0)) run(); },
    unmount: () => { pending.length = 0; context.cleanupEffects(); },
  };
}
