// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from 'bun:test';
import { inspectPublishOffer, reservePublish, supportsPublishCamera, usablePublishSender } from './publish-media';

const original = globalThis.RTCRtpSender;
afterEach(() => { globalThis.RTCRtpSender = original; });
const caps = { microphoneInjection: true, cameraInjection: true, mediaInjectionTransport: 'direct' };
const audio = { mimeType: 'audio/opus', clockRate: 48000, channels: 2 };
const video = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };

function fixture(camera = true) {
  globalThis.RTCRtpSender = { getCapabilities: (kind: string) => ({ codecs: kind === 'audio' ? [audio] : camera ? [video] : [] }) } as unknown as typeof RTCRtpSender;
  const added: { kind: string; options: RTCRtpTransceiverInit }[] = [];
  const preferred: RTCRtpCodec[][] = [];
  const pc = { addTransceiver(kind: string, options: RTCRtpTransceiverInit) {
    added.push({ kind, options });
    return { mid: String(added.length + 1), currentDirection: 'sendonly', sender: {}, setCodecPreferences(codecs: RTCRtpCodec[]) { preferred.push(codecs); } };
  } } as unknown as RTCPeerConnection;
  return { pc, added, preferred };
}

// Browser-generated section shape. No rewritten/dummy-track SDP in production.
const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\na=sendonly\r\na=ssrc:100 cname:test\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=42e01f\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:3\r\na=sendonly\r\na=ssrc:101 cname:test\r\na=rtpmap:111 opus/48000/2\r\n';

test('trackless reservations keep video then audio, exact codecs and the uplink cap', () => {
  const f = fixture();
  const reservations = reservePublish(f.pc, caps);
  expect(f.added).toEqual([
    { kind: 'video', options: { direction: 'sendonly', sendEncodings: [{ maxBitrate: 1000000 }] } },
    { kind: 'audio', options: { direction: 'sendonly' } },
  ]);
  expect(f.preferred).toEqual([[video], [audio]]);
  inspectPublishOffer(reservations, sdp);
  expect([...reservations.offered]).toEqual(['audio', 'video']);
  expect(usablePublishSender(reservations, 'audio')).toBe(reservations.transceivers.audio!.sender);
});

test('receive-only configuration never reserves upstream sections', () => {
  const f = fixture();
  reservePublish(f.pc);
  expect(f.added).toEqual([]);
});

test('microphone does not depend on a camera encoder', () => {
  const f = fixture(false);
  expect(supportsPublishCamera()).toBe(false);
  const reservations = reservePublish(f.pc, caps);
  inspectPublishOffer(reservations, ('v=0\r\n' + sdp.slice(sdp.indexOf('m=audio'))).replace('a=mid:3', 'a=mid:2'));
  expect(f.added).toEqual([{ kind: 'audio', options: { direction: 'sendonly' } }]);
  expect([...reservations.offered]).toEqual(['audio']);
});

test('missing SSRCs are unsupported without SDP surgery', () => {
  const f = fixture();
  const reservations = reservePublish(f.pc, caps);
  inspectPublishOffer(reservations, sdp.replaceAll(/a=ssrc:[^\r]+\r\n/g, ''));
  expect([...reservations.offered]).toEqual([]);
  expect(usablePublishSender(reservations, 'audio')).toBeUndefined();
});

test('incompatible H.264 profile is not a camera encoder', () => {
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [{ ...video, sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' }] }) } as unknown as typeof RTCRtpSender;
  expect(supportsPublishCamera()).toBe(false);
});

test.each(['42e01f', '42e02a', '42c020', '4d0028', '640c33'])('camera accepts profile and offered level %s unchanged', profile => {
  const f = fixture();
  const offered = { ...video, sdpFmtpLine: 'packetization-mode=1;profile-level-id=' + profile };
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [offered] }) } as unknown as typeof RTCRtpSender;
  expect(supportsPublishCamera()).toBe(true);
  reservePublish(f.pc, caps);
  expect(f.preferred[0]).toEqual([offered]);
});

test.each(['42e01e', '42c00b', '4d001e', '640c1e', '12342a'])('camera rejects unsupported profile/level %s', profile => {
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [{ ...video, sdpFmtpLine: 'packetization-mode=1;profile-level-id=' + profile }] }) } as unknown as typeof RTCRtpSender;
  expect(supportsPublishCamera()).toBe(false);
});
