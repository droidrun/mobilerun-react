// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { tick } from '../hooks/test-hook-runner';
import { event, fixture } from '../hooks/webrtc-test-fixture';
import { createRTCConfigurationRequest, createScreenshotRequest } from '../webrtc-messages';
import { expectAllFixturesUsed, loadFixture } from './fixtures';

interface Example {
  name: string;
  json: Record<string, any>;
}
const examples = (file: string) => loadFixture<{ examples: Example[] }>(`signalling/${file}.json`).examples;
const sequence = loadFixture('signalling/sequence.json');
const { timing, channels } = sequence;

const COVERED = [
  'client-candidate', 'client-keep-alive', 'client-offer', 'client-open-url', 'client-request-frame',
  'client-request-rtc-configuration', 'client-screenshot-request', 'sequence', 'server-answer',
  'server-candidate', 'server-rtc-configuration', 'server-screenshot-error', 'server-screenshot',
];
expectAllFixturesUsed('signalling', COVERED);

// Client frames are observed on the fake socket while the real hook runs.
describe('signalling/client frames', () => {
  for (const e of examples('client-request-rtc-configuration')) {
    test(`requestRtcConfiguration: ${e.name}`, () => {
      expect(createRTCConfigurationRequest(e.json.sessionId)).toEqual(e.json as any);
    });
    test(`requestRtcConfiguration is the first frame sent: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(e.json.sessionId);
      f.sockets[0].open();
      await tick();
      expect(f.sockets[0].sent[0]).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-screenshot-request')) {
    test(`screenshot: ${e.name}`, () => {
      expect(createScreenshotRequest(e.json.id)).toEqual(e.json as any);
    });
  }

  for (const e of examples('client-offer')) {
    test(`offer: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate(e.json.sessionId);
      f.peers[0].offer.resolve({ sdp: e.json.sdp });
      await tick();
      f.peers[0].local.resolve();
      await tick();
      expect(f.sockets[0].sent.find((m) => m.type === 'offer')).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-candidate')) {
    test(`candidate: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate(e.json.sessionId);
      f.peers[0].onicecandidate({
        candidate: { candidate: e.json.candidate, sdpMid: e.json.sdpMid, sdpMLineIndex: e.json.sdpMLineIndex },
      });
      expect(f.sockets[0].sent.find((m) => m.type === 'candidate')).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-request-frame')) {
    test(`requestFrame burst: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate(e.json.sessionId);
      const before = f.scheduled.length;
      f.peers[0].channels[0].onopen();
      // Scheduled offsets of the burst: +0, +125, ... (the first one may be immediate).
      const offsets = f.scheduled.slice(before).filter((s) => s.kind === 'timeout').map((s) => s.ms);
      expect(offsets).toHaveLength(timing.request_frame_count);
      expect(offsets).toEqual(
        Array.from({ length: timing.request_frame_count }, (_, i) => i * timing.request_frame_interval_ms),
      );
      f.fireTimers();
      const frames = f.sockets[0].sent.filter((m) => m.type === 'requestFrame');
      expect(frames).toHaveLength(timing.request_frame_count);
      for (const frame of frames) expect(frame).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-open-url')) {
    test(`openUrl: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate(e.json.sessionId, encodeURIComponent(e.json.url));
      f.peers[0].channels[0].onopen();
      expect(f.sockets[0].sent.find((m) => m.type === 'openUrl')).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-keep-alive')) {
    test(`keepAlive: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(e.json.sessionId);
      f.sockets[0].open();
      await tick();
      expect(f.scheduled.filter((s) => s.kind === 'interval').map((s) => s.ms)).toEqual([
        timing.keep_alive_interval_ms,
      ]);
      f.fireTimers();
      expect(f.sockets[0].sent.find((m) => m.type === 'keepAlive')).toEqual(e.json);
      f.unmount();
    });
  }
});

describe('signalling/sequence', () => {
  for (const [name, spec] of Object.entries(channels) as [string, any][]) {
    test(`${name} data channel options`, async () => {
      const f = await fixture();
      await f.negotiate();
      const created = f.peers[0].channelOptions.find((c) => c.label === spec.label)!;
      expect(created.options).toEqual({
        ordered: spec.ordered,
        ...(spec.maxRetransmits === null ? {} : { maxRetransmits: spec.maxRetransmits }),
        negotiated: spec.negotiated,
        id: spec.id,
      });
      f.unmount();
    });
  }

  test('handshake timeouts', async () => {
    const f = await fixture();
    f.mount();
    expect(f.scheduled.map((s) => s.ms)).toContain(timing.ws_open_timeout_ms);
    f.sockets[0].open();
    await tick();
    expect(f.scheduled.map((s) => s.ms)).toContain(timing.rtc_config_timeout_ms);
    f.unmount();
  });
});

describe('signalling/server frames', () => {
  for (const e of examples('server-answer')) {
    test(`answer: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate();
      const answer = f.sockets[0].onmessage!(event(e.json));
      f.peers[0].remote.resolve();
      await answer;
      expect(f.peers[0].remoteArgs).toEqual([{ type: 'answer', sdp: e.json.sdp }]);
      f.unmount();
    });
  }

  for (const e of examples('server-candidate')) {
    const { type: _type, ...candidate } = e.json;
    test(`candidate after answer: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate();
      const answer = f.sockets[0].onmessage!(event(examples('server-answer')[0].json));
      f.peers[0].remote.resolve();
      await answer;
      const added = f.sockets[0].onmessage!(event(e.json));
      f.peers[0].ice.resolve();
      await added;
      expect(f.peers[0].iceArgs).toEqual([candidate]);
      f.unmount();
    });
    test(`candidate before answer is buffered then applied in order: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate();
      await f.sockets[0].onmessage!(event(e.json));
      expect(f.peers[0].iceArgs).toEqual([]);
      const answer = f.sockets[0].onmessage!(event(examples('server-answer')[0].json));
      f.peers[0].remote.resolve();
      await tick();
      f.peers[0].ice.resolve();
      await answer;
      expect(f.peers[0].iceArgs).toEqual([candidate]);
      f.unmount();
    });
  }

  for (const e of examples('server-rtc-configuration')) {
    test(`rtcConfiguration refresh: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate();
      const iceServers = e.json.rtcConfiguration?.iceServers;
      const refresh = f.sockets[0].onmessage!(event(e.json));
      if (iceServers) {
        f.peers[0].offer.resolve({ sdp: 'restart' });
        await tick();
        f.peers[0].local.resolve();
      }
      await refresh;
      if (iceServers) {
        expect(f.peers[0].configArgs).toEqual([{ iceServers }]);
        expect(f.sockets[0].sent.some((m) => m.type === 'offer' && m.sdp === 'restart')).toBe(true);
      } else {
        expect(f.peers[0].configArgs).toEqual([]);
        expect(f.peers[0].localCalls).toBe(0);
      }
      f.unmount();
    });
  }

  for (const e of examples('server-screenshot')) {
    test(`screenshot: ${e.name}`, async () => {
      const f = await fixture();
      const result = f.mount() as any;
      const received: unknown[] = [];
      result.pendingScreenshotResolversRef.current.set(e.json.id, (v: unknown) => received.push(v));
      f.sockets[0].open();
      await tick();
      f.sockets[0].config();
      await tick();
      await f.sockets[0].onmessage!(event(e.json));
      expect(received).toEqual([{ dataUri: e.json.dataUri }]);
      f.unmount();
    });
  }

  for (const e of examples('server-screenshot-error')) {
    test(`screenshotError: ${e.name}`, async () => {
      const f = await fixture();
      const result = f.mount() as any;
      const received: unknown[] = [];
      result.pendingScreenshotRejectersRef.current.set(e.json.id, (v: unknown) => received.push(v));
      f.sockets[0].open();
      await tick();
      f.sockets[0].config();
      await tick();
      await f.sockets[0].onmessage!(event(e.json));
      expect((received[0] as Error).message).toBe(e.json.message);
      f.unmount();
    });
  }
});
