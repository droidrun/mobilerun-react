// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure input routing for the device stream: browser input facts in, wire
 * messages out. No DOM access, so the decisions are table-testable against the
 * shared conformance vectors; `use-scrcpy-input` only translates DOM events.
 */

import { AMOTION_EVENT, ANDROID_KEYS, codeMap } from '../constants';
import {
  createInjectKeycodeMessage,
  createInjectMouseHoverMessage,
  createInjectScrollEventMessage,
  createInjectTextMessage,
  createSetClipboardMessage,
  createTouchControlMessage,
} from '../webrtc-messages';

export interface RoutedMessage {
  /** `control` is the ordered reliable channel, `hover` the lossy hover channel. */
  channel: 'control' | 'hover';
  data: ArrayBuffer;
}

export interface VideoPoint {
  x: number;
  y: number;
}

// ---------------------------------------------------------------- geometry

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a client-coordinate point onto the video's pixel space, accounting for
 * the letterboxing object-fit:contain introduces. Returns null when the point
 * falls outside the rendered video area.
 */
export function mapClientPoint(
  rect: ViewRect,
  videoWidth: number,
  videoHeight: number,
  clientX: number,
  clientY: number,
): VideoPoint | null {
  const displayWidth = rect.width;
  const displayHeight = rect.height;
  if (displayWidth <= 0 || displayHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
  const videoAspectRatio = videoWidth / videoHeight;
  const containerAspectRatio = displayWidth / displayHeight;
  let actualWidth = displayWidth;
  let actualHeight = displayHeight;
  if (videoAspectRatio > containerAspectRatio) {
    actualHeight = displayWidth / videoAspectRatio;
  } else {
    actualWidth = displayHeight * videoAspectRatio;
  }
  const offsetX = (displayWidth - actualWidth) / 2;
  const offsetY = (displayHeight - actualHeight) / 2;
  const relativeX = clientX - rect.left - offsetX;
  const relativeY = clientY - rect.top - offsetY;
  if (relativeX < 0 || relativeX > actualWidth || relativeY < 0 || relativeY > actualHeight) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(videoWidth, (relativeX / actualWidth) * videoWidth)),
    y: Math.max(0, Math.min(videoHeight, (relativeY / actualHeight) * videoHeight)),
  };
}

// ---------------------------------------------------------------- keyboard

export interface KeyInput {
  type: 'keydown' | 'keyup';
  /** Physical key (`KeyboardEvent.code`). */
  code: string;
  /** Produced key value (`KeyboardEvent.key`). */
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  capsLock: boolean;
}

export type KeyRoute =
  | { kind: 'messages'; messages: RoutedMessage[] }
  /** Ctrl/Cmd+V: the caller reads the clipboard and sends `pasteMessages(text)`. */
  | { kind: 'paste' };

const control = (data: ArrayBuffer): RoutedMessage => ({ channel: 'control', data });

const CONTROL_KEYS = new Set([
  'Backspace',
  'Delete',
  'Enter',
  'Tab',
  'Escape',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]);
const MODIFIER_PREFIXES = ['Shift', 'Control', 'Alt', 'Meta'];

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

// A named key (`ContextMenu`, `Dead`) is more than one UTF-16 unit but is not text.
function isGraphemeText(key: string): boolean {
  if (key.length < 2 || !graphemes || /\p{Cc}/u.test(key)) return false;
  const iterator = graphemes.segment(key)[Symbol.iterator]();
  iterator.next();
  return iterator.next().done === true;
}

function isControlKey(e: KeyInput): boolean {
  return (
    CONTROL_KEYS.has(e.key) ||
    e.key.startsWith('Arrow') ||
    (e.key.startsWith('F') && e.key.length <= 3) ||
    MODIFIER_PREFIXES.some((prefix) => e.key.startsWith(prefix)) ||
    e.ctrl ||
    e.meta
  );
}

function metaState(e: KeyInput): number {
  const isLetter = e.code >= 'KeyA' && e.code <= 'KeyZ';
  // CapsLock flips shift for letters only.
  const shift = isLetter ? e.shift !== e.capsLock : e.shift;
  let state = ANDROID_KEYS.META_NONE;
  if (shift) state |= ANDROID_KEYS.META_SHIFT_ON;
  if (e.ctrl) state |= ANDROID_KEYS.META_CTRL_ON;
  if (e.alt) state |= ANDROID_KEYS.META_ALT_ON;
  if (e.meta) state |= ANDROID_KEYS.META_META_ON;
  return state;
}

function keycodeMessage(action: number, keycode: number, meta: number): RoutedMessage {
  return control(createInjectKeycodeMessage(action, keycode, 0, meta));
}

export function pasteMessages(clipboardText: string): RoutedMessage[] {
  return clipboardText ? [control(createSetClipboardMessage(clipboardText, true))] : [];
}

/**
 * Keyboard routing with the pressed-key bookkeeping that keeps every keycode
 * DOWN paired with exactly one UP.
 */
export function createKeyRouter() {
  const pressed = new Set<string>();

  return {
    route(e: KeyInput): KeyRoute {
      const keycode = codeMap[e.code];

      if (e.type === 'keyup') {
        if (!pressed.delete(e.code) || !keycode) return { kind: 'messages', messages: [] };
        return {
          kind: 'messages',
          messages: [keycodeMessage(ANDROID_KEYS.ACTION_UP, keycode, metaState(e))],
        };
      }

      if (e.ctrl || e.meta) {
        const key = e.key.toLowerCase();
        if (key === 'v') return { kind: 'paste' };
        if (key === 'm') {
          return {
            kind: 'messages',
            messages: [
              keycodeMessage(ANDROID_KEYS.ACTION_DOWN, ANDROID_KEYS.MENU, ANDROID_KEYS.META_NONE),
              keycodeMessage(ANDROID_KEYS.ACTION_UP, ANDROID_KEYS.MENU, ANDROID_KEYS.META_NONE),
            ],
          };
        }
      }

      // Printable characters go as text (Unicode, fast typing, no up/down pairs).
      if (!isControlKey(e) && (e.key.length === 1 || isGraphemeText(e.key))) {
        return { kind: 'messages', messages: [control(createInjectTextMessage(e.key))] };
      }

      if (!keycode) return { kind: 'messages', messages: [] };
      pressed.add(e.code);
      return {
        kind: 'messages',
        messages: [keycodeMessage(ANDROID_KEYS.ACTION_DOWN, keycode, metaState(e))],
      };
    },
  };
}

// ---------------------------------------------------------------- pointers

export interface PointerInput {
  type: 'down' | 'move' | 'up' | 'cancel';
  /** Touch identifier; ignored for the mouse. */
  id: number;
  /** Position in video pixels, or null when outside the rendered video. */
  point: VideoPoint | null;
  mouse: boolean;
  /** Changed button: 0 primary, 1 middle, 2 secondary. */
  button: number;
  /** Held-button mask, only used by hover. */
  buttons: number;
}

export const MAX_TOUCH_SLOTS = 10;
export const MOUSE_POINTER_ID = -1;

/**
 * Touch and mouse gesture routing. Each touch gets the lowest free slot
 * (0..9) for the length of its gesture; the mouse always uses id -1.
 */
export function createPointerRouter() {
  const active = new Map<string, { slot: number; x: number; y: number }>();

  return {
    route(e: PointerInput, videoWidth: number, videoHeight: number): RoutedMessage[] {
      if (!videoWidth || !videoHeight) return [];
      if ((e.type === 'down' || e.type === 'up') && e.button !== 0) return [];

      const key = e.mouse ? 'mouse' : String(e.id);
      let pointer = active.get(key);
      let action: number;

      if (e.type === 'down') {
        if (!e.point || pointer) return [];
        let slot = MOUSE_POINTER_ID;
        if (!e.mouse) {
          const used = new Set([...active.values()].map((p) => p.slot));
          slot = 0;
          while (used.has(slot)) slot++;
          if (slot >= MAX_TOUCH_SLOTS) return [];
        }
        pointer = { slot, x: e.point.x, y: e.point.y };
        active.set(key, pointer);
        action = AMOTION_EVENT.ACTION_DOWN;
      } else if (e.type === 'move') {
        if (!e.point) return [];
        if (!pointer) {
          // Hover: a mouse moving with no gesture in progress.
          if (!e.mouse) return [];
          return [
            {
              channel: 'hover',
              data: createInjectMouseHoverMessage(
                videoWidth,
                videoHeight,
                e.point.x,
                e.point.y,
                e.buttons,
              ),
            },
          ];
        }
        pointer.x = e.point.x;
        pointer.y = e.point.y;
        action = AMOTION_EVENT.ACTION_MOVE;
      } else {
        if (!pointer) return [];
        // UP/CANCEL go out at the last position seen inside the video.
        action = e.type === 'cancel' ? AMOTION_EVENT.ACTION_CANCEL : AMOTION_EVENT.ACTION_UP;
        active.delete(key);
      }

      return [
        control(
          createTouchControlMessage(
            action,
            pointer.slot,
            videoWidth,
            videoHeight,
            pointer.x,
            pointer.y,
            1.0,
            AMOTION_EVENT.BUTTON_PRIMARY,
            AMOTION_EVENT.BUTTON_PRIMARY,
          ),
        ),
      ];
    },
    /** Whether the mouse currently holds a gesture. */
    hasMouseGesture: () => active.has('mouse'),
  };
}

// ------------------------------------------------------------------ scroll

/**
 * Browser wheel deltas → wheel ticks (1 tick ≈ one notch), with the sign
 * flipped: Android scrolls up on positive v and left on positive h, browsers
 * report positive deltaY when content moves down.
 *
 * Pixel mode uses /100 (Chrome ~100px per notch), the de-facto convention of
 * ya-webadb/Tango; it suits mice and trackpads alike.
 */
export function wheelToTicks(
  deltaMode: number,
  deltaX: number,
  deltaY: number,
): { h: number; v: number } {
  let dx = deltaX;
  let dy = deltaY;
  switch (deltaMode) {
    case 0: // DOM_DELTA_PIXEL
      dx /= 100;
      dy /= 100;
      break;
    case 2: // DOM_DELTA_PAGE
      dx *= 3;
      dy *= 3;
      break;
    // DOM_DELTA_LINE (1) is already roughly in tick units.
  }
  return { h: -dx, v: -dy };
}

export function routeScroll(
  videoWidth: number,
  videoHeight: number,
  point: VideoPoint | null,
  h: number,
  v: number,
  buttons: number,
): RoutedMessage[] {
  if (!videoWidth || !videoHeight || !point) return [];
  return [
    control(
      createInjectScrollEventMessage(videoWidth, videoHeight, point.x, point.y, h, v, buttons),
    ),
  ];
}
