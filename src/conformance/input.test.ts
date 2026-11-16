// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import {
  createKeyRouter,
  createPointerRouter,
  mapClientPoint,
  pasteMessages,
  routeScroll,
  type RoutedMessage,
  type VideoPoint,
} from '../lib/input-routing';
import { loadFixture, toHex } from './fixtures';

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
        // The fixture positions are upright video pixels; the DOM layer maps client points the same way.
        const inside = c.video_width > 0 && c.video_height > 0 &&
          e.x >= 0 && e.x <= c.video_width && e.y >= 0 && e.y <= c.video_height;
        const point: VideoPoint | null = inside ? { x: e.x, y: e.y } : null;
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
      const inside = c.x >= 0 && c.x <= c.video_width && c.y >= 0 && c.y <= c.video_height;
      const point = inside ? { x: c.x, y: c.y } : null;
      expect(wire(routeScroll(c.video_width, c.video_height, point, c.h, c.v, c.buttons))).toEqual(c.expect);
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
