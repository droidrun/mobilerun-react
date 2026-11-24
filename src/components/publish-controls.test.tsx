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
const labels = resolveDeviceStreamLabels({ microphone: 'Mikrofon', camera: 'Kamera', stopMicrophone: 'Mikrofon aus', stopCamera: 'Kamera aus', publishStarting: 'Starte', publishPermissionDenied: 'Erlaubnis fehlt', publishNotAllowed: 'Nicht erlaubt' });
const props: PublishControlsProps = { capabilities, offeredKinds: ['audio', 'video'], connected: true, labels, state: INITIAL_PUBLISH_STATE, start: async () => INITIAL_PUBLISH_STATE, stop: async () => {} };
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
  expect(active).toContain('aria-label="Mikrofon aus"');
  expect(active.match(/aria-pressed="true"/g)).toHaveLength(2);
  const pending = render({ state: { phase: 'starting', mediaSessionId: 'id', kinds: ['audio', 'video'] } });
  expect(pending).toContain('Starte');
  expect(pending.match(/disabled=""/g)).toHaveLength(2);
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
  expect(serverMarkup).toContain('Kamera');
  expect(render({ offeredKinds: ['audio'] })).not.toContain('Kamera');
});

test('DeviceStream hides the pill by prop and without capabilities, independently of hasControl', () => {
  expect(renderToStaticMarkup(<DeviceStream streamUrl="wss://example.invalid" hasControl={false} />)).not.toContain('mr-publish-pill');
  expect(renderToStaticMarkup(<DeviceStream streamUrl="wss://example.invalid" hasControl={false} publishCapabilities={capabilities} />)).not.toContain('mr-publish-pill');
  expect(renderToStaticMarkup(<DeviceStream streamUrl="wss://example.invalid" hasControl publishCapabilities={capabilities} hidePublishControls />)).not.toContain('mr-publish-pill');
});

test('unsupported publication hides the pill without another label key', () => {
  expect(render({ state: { phase: 'error', reason: 'publish_unsupported', mediaSessionId: null, kinds: ['audio'] } })).toBe('');
  expect(render({ offeredKinds: [] })).toBe('');
});

test('pill fades after three seconds and nearby pointer/touch restores it without consuming events', async () => {
  const { runHook } = await import('../hooks/test-hook-runner');
  const { FakeSchedule } = await import('../lib/test-clock');
  const clock = new FakeSchedule();
  const listeners = new Map<string, (event: object) => void>();
  const runner = await runHook<{ PublishControls: (props: PublishControlsProps) => any }>(import.meta.dir + '/publish-controls.tsx', {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    window: { addEventListener(name: string, fn: (event: object) => void) { listeners.set(name, fn); }, removeEventListener(name: string) { listeners.delete(name); } },
  });
  const renderPill = () => { runner.beginRender(); return runner.module.exports.PublishControls(props); };
  const pill = renderPill();
  pill.props.ref.current = { getBoundingClientRect: () => ({ left: 100, right: 200, top: 600, bottom: 650 }), addEventListener() {}, removeEventListener() {} };
  runner.flushEffects();
  clock.advance(2999);
  expect(renderPill().props['data-dimmed']).toBe(false);
  clock.advance(1);
  expect(renderPill().props['data-dimmed']).toBe(true);
  listeners.get('pointermove')!({ clientX: 90, clientY: 620 });
  expect(renderPill().props['data-dimmed']).toBe(false);
  clock.advance(3000);
  expect(renderPill().props['data-dimmed']).toBe(true);
  listeners.get('touchstart')!({ touches: [{ clientX: 150, clientY: 660 }] });
  expect(renderPill().props['data-dimmed']).toBe(false);
  runner.unmount();
  expect(clock.pendingCount).toBe(0);
  expect(listeners.size).toBe(0);
});
