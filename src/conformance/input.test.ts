// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import {
  createKeyRouter,
  createPointerRouter,
  mapClientPoint,
  pasteMessages,
  routeScroll,
  wheelToTicks,
  type RoutedMessage,
  type VideoPoint,
} from '../lib/input-routing';
import { expectAllFixturesUsed, loadFixture, toHex } from './fixtures';

expectAllFixturesUsed('input', ['geometry', 'ime', 'keys', 'pointers', 'scroll']);

interface Expected {
  channel: 'control' | 'hover';
  hex: string;
}
const wire = (messages: RoutedMessage[]): Expected[] =>
  messages.map((m) => ({ channel: m.channel, hex: toHex(m.data) }));

// ------------------------------------------------------------------- keys

interface KeyCase {
  name: string;
  events: {
    type: 'keydown' | 'keyup';
    code: string;
    key: string;
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
    meta: boolean;
    caps_lock: boolean;
    clipboard: string;
  }[];
  expect: Expected[];
}

describe('input/keys', () => {
  for (const c of loadFixture<{ cases: KeyCase[] }>('input/keys.json').cases) {
    test(c.name, () => {
      const router = createKeyRouter();
      const out: RoutedMessage[] = [];
      for (const e of c.events) {
        const routed = router.route({ ...e, capsLock: e.caps_lock });
        if (routed.kind === 'paste') out.push(...pasteMessages(e.clipboard));
        else out.push(...routed.messages);
      }
      expect(wire(out)).toEqual(c.expect);
    });
  }
});

// --------------------------------------------------------------- pointers

interface PointerCase {
  name: string;
  video_width: number;
  video_height: number;
  events: {
    type: 'down' | 'move' | 'up' | 'cancel';
    id: number;
    x: number;
    y: number;
    mouse: boolean;
    button: number;
    buttons: number;
  }[];
  expect: Expected[];
}

describe('input/pointers', () => {
  for (const c of loadFixture<{ cases: PointerCase[] }>('input/pointers.json').cases) {
    test(c.name, () => {
      const router = createPointerRouter();
      const out: RoutedMessage[] = [];
      for (const e of c.events) {
        // Fixture positions are upright video pixels: view == video, no letterbox.
        const point = mapClientPoint(
          { left: 0, top: 0, width: c.video_width, height: c.video_height },
          c.video_width, c.video_height, e.x, e.y,
        );
        out.push(...router.route({ ...e, point }, c.video_width, c.video_height));
      }
      expect(wire(out)).toEqual(c.expect);
    });
  }
});

// --------------------------------------------------------------- geometry

interface GeometryCase {
  name: string;
  view_width: number;
  view_height: number;
  video_width: number;
  video_height: number;
  rotation: 0 | 90 | 180 | 270;
  x: number;
  y: number;
  expect: { width: number; height: number; x: number; y: number } | null;
}

describe('input/geometry', () => {
  for (const c of loadFixture<{ cases: GeometryCase[] }>('input/geometry.json').cases) {
    // The browser video element is always upright; rotation is a native-SDK concern.
    const run = c.rotation === 0 ? test : test.skip;
    run(`${c.name}${c.rotation ? ` (rotation ${c.rotation}, not applicable)` : ''}`, () => {
      const point = mapClientPoint(
        { left: 0, top: 0, width: c.view_width, height: c.view_height },
        c.video_width,
        c.video_height,
        c.x,
        c.y,
      );
      expect(point).toEqual(c.expect ? { x: c.expect.x, y: c.expect.y } : null);
    });
  }
});

// ----------------------------------------------------------------- scroll

interface ScrollCase {
  name: string;
  video_width: number;
  video_height: number;
  x: number;
  y: number;
  h: number;
  v: number;
  buttons: number;
  expect: Expected[];
}

describe('input/scroll', () => {
  for (const c of loadFixture<{ cases: ScrollCase[] }>('input/scroll.json').cases) {
    test(c.name, () => {
      const point = mapClientPoint(
        { left: 0, top: 0, width: c.video_width, height: c.video_height },
        c.video_width, c.video_height, c.x, c.y,
      );
      expect(wire(routeScroll(c.video_width, c.video_height, point, c.h, c.v, c.buttons))).toEqual(c.expect);
    });
  }
});

// Browser wheel deltas → scroll bytes. Literal expectations: the vectors above start
// at abstract ticks, so sign and per-mode scaling are pinned here.
// Frame: type 3, x=540, y=1200, 1080x2400, hscroll i16, vscroll i16, buttons 0.
describe('wheel conversion', () => {
  const frame = (h: string, v: string) => `031c020000b004000038046009${h}${v}00000000`;
  const table: [string, number, number, number, string][] = [
    ['pixel: 100px down is one tick down', 0, 0, 100, frame('0000', '00f8')],
    ['pixel: 100px up is one tick up', 0, 0, -100, frame('0000', '0008')],
    ['pixel: 100px right scrolls left', 0, 100, 0, frame('00f8', '0000')],
    ['pixel: 50px left is half a tick', 0, -50, 0, frame('0004', '0000')],
    ['line: 3 lines down are 3 ticks', 1, 0, 3, frame('0000', '00e8')],
    ['page: one page is 3 ticks', 2, 0, 1, frame('0000', '00e8')],
  ];
  for (const [name, mode, dx, dy, hex] of table) {
    test(name, () => {
      const { h, v } = wheelToTicks(mode, dx, dy);
      const point = { x: 540, y: 1200 };
      expect(wire(routeScroll(1080, 2400, point, h, v, 0))).toEqual([{ channel: 'control', hex }]);
    });
  }
});

// -------------------------------------------------------------------- ime

// Browser keyboard input has no composition or commit path in React: text
// arrives as keydown `key` values (covered by input/keys). The cases of
// input/ime.json describe SDK text-commit operations and are not applicable.
describe('input/ime', () => {
  for (const c of loadFixture<{ cases: { name: string }[] }>('input/ime.json').cases) {
    test.skip(`${c.name} (not applicable: no composition path in the browser input)`, () => {});
  }
});
