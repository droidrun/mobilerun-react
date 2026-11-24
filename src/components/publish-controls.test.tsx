// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { INITIAL_PUBLISH_STATE } from '../lib/publish';
import { resolveDeviceStreamLabels } from '../lib/stream-error';
import { PublishControls, type PublishControlsProps } from './publish-controls';
import { DeviceStream } from './device-stream';

const original = globalThis.RTCRtpSender;
afterEach(() => { globalThis.RTCRtpSender = original; });
const capabilities = { microphoneInjection: true, cameraInjection: true, mediaInjectionTransport: 'direct' };
const labels = resolveDeviceStreamLabels({ publishMicrophone: 'Mikrofon', publishCamera: 'Kamera', publishStarting: 'Starte', publishPermissionDenied: 'Erlaubnis fehlt', publishNotAllowed: 'Nicht erlaubt' });
const props: PublishControlsProps = { capabilities, connected: true, labels, state: INITIAL_PUBLISH_STATE, start: async () => INITIAL_PUBLISH_STATE, stop: async () => {} };
const render = (overrides: Partial<PublishControlsProps> = {}) => renderToStaticMarkup(<PublishControls {...props} {...overrides} />);

function cameraEncoder() {
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' }] }) } as unknown as typeof RTCRtpSender;
}

test.each([
  { capabilities: undefined }, { hidden: true },
  { capabilities: { ...capabilities, microphoneInjection: false } },
  { capabilities: { ...capabilities, mediaInjectionTransport: 'relay' } },
])('pill is hidden with %j', overrides => {
  expect(render(overrides)).toBe('');
});

test('pill labels, active red selector and pending disabled states are accessible', () => {
  cameraEncoder();
  const active = render({ state: { phase: 'active', mediaSessionId: 'id', kinds: ['audio', 'video'] } });
  expect(active).toContain('aria-label="Mikrofon"');
  expect(active.match(/aria-pressed="true"/g)).toHaveLength(1);
  const pending = render({ state: { phase: 'starting', mediaSessionId: 'id', kinds: ['audio', 'video'] } });
  expect(pending).toContain('Starte');
  expect(pending.match(/disabled=""/g)).toHaveLength(1);
});

test.each([['permission_denied', 'Erlaubnis fehlt'], ['publish_not_allowed', 'Nicht erlaubt']] as const)('pill shows translated %s', (reason, label) => {
  expect(render({ state: { phase: 'error', mediaSessionId: null, kinds: ['audio'], reason } })).toContain(label);
});

test('server markup does not depend on the local camera encoder, avoiding hydration drift', () => {
  cameraEncoder();
  const serverMarkup = render();
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) } as unknown as typeof RTCRtpSender;
  expect(render()).toBe(serverMarkup);
  expect(serverMarkup).toContain('Mikrofon');
  expect(serverMarkup).not.toContain('Kamera');
});

test('DeviceStream hides the pill by prop and without capabilities, independently of hasControl', () => {
  expect(renderToStaticMarkup(<DeviceStream streamUrl="wss://example.invalid" hasControl={false} />)).not.toContain('mr-publish-pill');
  expect(renderToStaticMarkup(<DeviceStream streamUrl="wss://example.invalid" hasControl={false} publishCapabilities={capabilities} />)).toContain('mr-publish-pill');
  expect(renderToStaticMarkup(<DeviceStream streamUrl="wss://example.invalid" hasControl publishCapabilities={capabilities} hidePublishControls />)).not.toContain('mr-publish-pill');
});
