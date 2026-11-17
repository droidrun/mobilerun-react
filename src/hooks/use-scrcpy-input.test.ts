// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { runHook } from './test-hook-runner';

type Handlers = {
  handleInteraction: (event: object) => void;
};

async function setup() {
  const sent: Uint8Array[] = [];
  const channel = { readyState: 'open', send: (data: ArrayBuffer) => void sent.push(new Uint8Array(data)) };
  const video = {
    videoWidth: 100,
    videoHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    focus() {},
  };
  const runner = await runHook<{ useScrcpyInput: (o: object) => Handlers }>(
    import.meta.dir + '/use-scrcpy-input.ts',
    { window: {}, document: {}, navigator: {} },
  );
  runner.beginRender();
  const handlers = runner.module.exports.useScrcpyInput({
    containerRef: { current: null },
    videoRef: { current: video },
    dataChannelRef: { current: channel },
    hoverChannelRef: { current: null },
  });
  const base = { preventDefault() {}, stopPropagation() {} };
  return {
    sent, channel,
    mouse: (type: string, x = 50, y = 50) =>
      handlers.handleInteraction({ ...base, type, button: 0, buttons: 1, clientX: x, clientY: y }),
    touch: (type: string, ids: number[]) =>
      handlers.handleInteraction({
        ...base, type, touches: [],
        changedTouches: ids.map((identifier) => ({ identifier, clientX: 50, clientY: 50 })),
      }),
    // Touch frame: byte 1 is the action, bytes 2-9 the big-endian pointer id.
    actions: () => sent.map((m) => m[1]),
    pointerIds: () => sent.map((m) => new DataView(m.buffer).getBigInt64(2)),
  };
}

const DOWN = 0, UP = 1;

describe('release while the control channel is closed', () => {
  test('mouse: the next down after reopening still produces DOWN', async () => {
    const f = await setup();
    f.mouse('mousedown');
    f.channel.readyState = 'closed';
    f.mouse('mouseup'); // dropped on the wire, but the router must see it
    f.channel.readyState = 'open';
    f.mouse('mousedown');
    expect(f.actions()).toEqual([DOWN, DOWN]);
  });

  test('touch: slots are freed for the next gesture', async () => {
    const f = await setup();
    const ids = Array.from({ length: 10 }, (_, i) => 1000 + i);
    f.touch('touchstart', ids);
    f.channel.readyState = 'closed';
    f.touch('touchend', ids);
    f.channel.readyState = 'open';
    f.sent.length = 0;
    f.touch('touchstart', ids.map((id) => id + 100));
    expect(f.actions()).toEqual(Array(10).fill(DOWN));
    expect(f.pointerIds()).toEqual(Array.from({ length: 10 }, (_, i) => BigInt(i)));
    f.touch('touchend', [1100]);
    expect(f.actions().at(-1)).toBe(UP);
  });
});
