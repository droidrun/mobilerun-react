// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { CONTROL_MSG_TYPE } from './constants';

export function createRTCConfigurationRequest(sessionId: string) {
  return {
    type: 'requestRtcConfiguration',
    sessionId,
    // Opt in to mid-session TURN credential refresh: the server only pushes
    // unsolicited rtcConfiguration (and this client's ICE restart handling
    // only runs) for viewers that advertise it.
    supportsLiveRtcRefresh: true,
  } as const;
}

export function createTouchControlMessage(
  action: number,
  pointerId: number,
  videoWidth: number,
  videoHeight: number,
  x: number,
  y: number,
  pressure = 1.0,
  actionButton = 0,
  buttons = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT);
  offset += 1;

  view.setUint8(offset, action);
  offset += 1;

  view.setBigInt64(offset, BigInt(pointerId));
  offset += 8;

  view.setInt32(offset, Math.round(x), true);
  offset += 4;
  view.setInt32(offset, Math.round(y), true);
  offset += 4;
  view.setUint16(offset, videoWidth, true);
  offset += 2;
  view.setUint16(offset, videoHeight, true);
  offset += 2;

  view.setInt16(offset, Math.round(pressure * 0xffff), true);
  offset += 2;

  view.setInt32(offset, actionButton, true);
  offset += 4;

  view.setInt32(offset, buttons, true);
  return buffer;
}

// Encode a normalized scroll value (in [-1, 1]) into scrcpy's i16 fixed-point.
// Mirrors `sc_float_to_i16fp` in scrcpy/app/src/util/binary.h.
function floatToI16FixedPoint(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  const scaled = Math.round(clamped * 0x8000);
  if (scaled >= 0x7fff) return 0x7fff;
  if (scaled < -0x8000) return -0x8000;
  return scaled;
}

// Builds an INJECT_SCROLL_EVENT control message (scrcpy v3 protocol).
//
// `hscrollTicks` / `vscrollTicks` are wheel ticks (1.0 = one notch). The desktop
// scrcpy client divides by 16 then clamps to [-1, 1] before encoding to i16fp,
// and the server multiplies by 16 to recover the original tick count.
//
// `buttons` is the bitmask of currently-pressed mouse buttons
// (AMOTION_EVENT.BUTTON_*), matching the desktop client's behaviour.
export function createInjectScrollEventMessage(
  videoWidth: number,
  videoHeight: number,
  x: number,
  y: number,
  hscrollTicks: number,
  vscrollTicks: number,
  buttons = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(21);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_SCROLL_EVENT);
  offset += 1;

  view.setInt32(offset, Math.round(x), true);
  offset += 4;
  view.setInt32(offset, Math.round(y), true);
  offset += 4;

  view.setUint16(offset, videoWidth, true);
  offset += 2;
  view.setUint16(offset, videoHeight, true);
  offset += 2;

  view.setInt16(offset, floatToI16FixedPoint(hscrollTicks / 16), true);
  offset += 2;
  view.setInt16(offset, floatToI16FixedPoint(vscrollTicks / 16), true);
  offset += 2;

  view.setInt32(offset, buttons, true);
  return buffer;
}

// Builds an INJECT_MOUSE_HOVER_EVENT — a custom (non-scrcpy) message that
// reports the cursor's current device-space position. Sent on mousemove when
// no button is held; consumed by the iOS backend, ignored by Android.
//
// Layout (17 bytes, little-endian):
//   type   u8
//   x      i32
//   y      i32
//   w      u16   // frame width at event time
//   h      u16   // frame height
//   btns   i32   // bitmask of currently-pressed buttons (AMOTION_EVENT.BUTTON_*)
export function createInjectMouseHoverMessage(
  videoWidth: number,
  videoHeight: number,
  x: number,
  y: number,
  buttons = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(17);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_MOUSE_HOVER_EVENT);
  offset += 1;

  view.setInt32(offset, Math.round(x), true);
  offset += 4;
  view.setInt32(offset, Math.round(y), true);
  offset += 4;

  view.setUint16(offset, videoWidth, true);
  offset += 2;
  view.setUint16(offset, videoHeight, true);
  offset += 2;

  view.setInt32(offset, buttons, true);
  return buffer;
}

export function createSetClipboardMessage(text: string, paste = true): ArrayBuffer {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  // 1 byte for type + 8 bytes for sequence + 1 byte for paste flag + 4 bytes for length + text bytes
  const buffer = new ArrayBuffer(14 + textBytes.length);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.SET_CLIPBOARD);
  offset += 1;

  // Use 0 as sequence since we don't need an acknowledgement
  view.setBigInt64(offset, BigInt(0), false);
  offset += 8;

  // Set paste flag
  view.setUint8(offset, paste ? 1 : 0);
  offset += 1;

  // Text length
  view.setUint32(offset, textBytes.length, false);
  offset += 4;

  // Text data
  new Uint8Array(buffer, offset).set(textBytes);

  return buffer;
}

export function createInjectTextMessage(text: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  // 1 byte for type + 4 bytes for length + text bytes
  const buffer = new ArrayBuffer(5 + textBytes.length);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_TEXT);
  offset += 1;

  // Text length (little-endian to match portal's ByteOrder.LITTLE_ENDIAN)
  view.setInt32(offset, textBytes.length, true);
  offset += 4;

  // Text data
  new Uint8Array(buffer, offset).set(textBytes);

  return buffer;
}

export function createInjectKeycodeMessage(
  action: number,
  keycode: number,
  repeat = 0,
  metaState = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(14);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_KEYCODE);
  offset += 1;

  view.setUint8(offset, action);
  offset += 1;

  view.setInt32(offset, keycode, true);
  offset += 4;

  view.setInt32(offset, repeat, true);
  offset += 4;

  view.setInt32(offset, metaState, true);
  return buffer;
}
