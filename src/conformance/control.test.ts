// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { AMOTION_EVENT, ANDROID_KEYS, CONTROL_MSG_TYPE, codeMap } from '../constants';
import {
  createInjectKeycodeMessage,
  createInjectMouseHoverMessage,
  createInjectScrollEventMessage,
  createInjectTextMessage,
  createSetClipboardMessage,
  createTouchControlMessage,
} from '../webrtc-messages';
import { loadFixture, toHex } from './fixtures';

interface Case {
  name: string;
  args: Record<string, any>;
  hex: string;
}

const builders: Record<string, (a: Record<string, any>) => ArrayBuffer> = {
  touch: (a) =>
    createTouchControlMessage(
      a.action,
      a.pointerId,
      a.videoWidth,
      a.videoHeight,
      a.x,
      a.y,
      a.pressure,
      a.actionButton,
      a.buttons,
    ),
  scroll: (a) =>
    createInjectScrollEventMessage(
      a.videoWidth,
      a.videoHeight,
      a.x,
      a.y,
      a.hscrollTicks,
      a.vscrollTicks,
      a.buttons,
    ),
  hover: (a) =>
    createInjectMouseHoverMessage(a.videoWidth, a.videoHeight, a.x, a.y, a.buttons),
  keycode: (a) => createInjectKeycodeMessage(a.action, a.keycode, a.repeat, a.metaState),
  text: (a) => createInjectTextMessage(a.text),
  'set-clipboard': (a) => createSetClipboardMessage(a.text, a.paste),
};

describe('constants', () => {
  const constants = loadFixture('constants.json');
  test('control message types', () => expect({ ...CONTROL_MSG_TYPE }).toMatchObject(constants.control_msg_type));
  test('motion event values', () => expect({ ...AMOTION_EVENT }).toMatchObject(constants.amotion_event));
  test('android keys', () => expect({ ...ANDROID_KEYS }).toMatchObject(constants.android_keys));
  test('keyboard code map', () => expect({ ...codeMap }).toEqual(constants.code_map));
});

for (const [family, build] of Object.entries(builders)) {
  describe(`control/${family}`, () => {
    for (const c of loadFixture<{ cases: Case[] }>(`control/${family}.json`).cases) {
      test(c.name, () => expect(toHex(build(c.args))).toBe(c.hex));
    }
  });
}
