// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { event, fixture, tick } from '../hooks/webrtc-test-fixture';
import { createRTCConfigurationRequest } from '../webrtc-messages';
import { loadFixture } from './fixtures';

interface Example {
  name: string;
  json: Record<string, any>;
}
const examples = (file: string) => loadFixture<{ examples: Example[] }>(`signalling/${file}.json`).examples;
const sequence = loadFixture('signalling/sequence.json');
const SESSION = 'sess_0123456789abcdef';

// Client frames are observed on the fake socket while the real hook runs.
describe('signalling/client frames', () => {
  for (const e of examples('client-request-rtc-configuration')) {
    test(`requestRtcConfiguration: ${e.name}`, () => {
      expect(createRTCConfigurationRequest(e.json.sessionId)).toEqual(e.json as any);
    });
    test(`requestRtcConfiguration is the first frame sent: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(SESSION);
      f.sockets[0].open();
      await tick();
      expect(f.sockets[0].sent[0]).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-offer')) {
    test(`offer: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(SESSION);
      f.sockets[0].open();
      await tick();
      f.sockets[0].config();
      await tick();
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
      f.mount(SESSION);
      f.sockets[0].open();
      await tick();
      f.sockets[0].config();
      await tick();
      f.peers[0].onicecandidate({
        candidate: { candidate: e.json.candidate, sdpMid: e.json.sdpMid, sdpMLineIndex: e.json.sdpMLineIndex },
      });
      expect(f.sockets[0].sent.find((m) => m.type === 'candidate')).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-request-frame')) {
    test(`requestFrame x${sequence.timing.request_frame_count}: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(SESSION);
      f.sockets[0].open();
      await tick();
      f.sockets[0].config();
      await tick();
      f.peers[0].channels[0].onopen();
      f.fireTimers();
      const frames = f.sockets[0].sent.filter((m) => m.type === 'requestFrame');
      expect(frames).toHaveLength(sequence.timing.request_frame_count);
      for (const frame of frames) expect(frame).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-open-url')) {
    test(`openUrl: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(SESSION, encodeURIComponent(e.json.url));
      f.sockets[0].open();
      await tick();
      f.sockets[0].config();
      await tick();
      f.peers[0].channels[0].onopen();
      expect(f.sockets[0].sent.find((m) => m.type === 'openUrl')).toEqual(e.json);
      f.unmount();
    });
  }

  for (const e of examples('client-keep-alive')) {
    test(`keepAlive: ${e.name}`, async () => {
      const f = await fixture();
      f.mount(SESSION);
      f.sockets[0].open();
      await tick();
      f.fireTimers();
      expect(f.sockets[0].sent.find((m) => m.type === 'keepAlive')).toEqual(e.json);
      f.unmount();
    });
  }
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
    test(`candidate after answer: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate();
      const answer = f.sockets[0].onmessage!(event({ type: 'answer', sdp: 'v=0' }));
      f.peers[0].remote.resolve();
      await answer;
      const added = f.sockets[0].onmessage!(event(e.json));
      f.peers[0].ice.resolve();
      await added;
      const { type: _type, ...candidate } = e.json;
      expect(f.peers[0].iceArgs).toEqual([candidate]);
      f.unmount();
    });
    test(`candidate before answer is buffered then applied in order: ${e.name}`, async () => {
      const f = await fixture();
      await f.negotiate();
      await f.sockets[0].onmessage!(event(e.json));
      expect(f.peers[0].iceArgs).toEqual([]);
      const answer = f.sockets[0].onmessage!(event({ type: 'answer', sdp: 'v=0' }));
      f.peers[0].remote.resolve();
      await tick();
      f.peers[0].ice.resolve();
      await answer;
      const { type: _type, ...candidate } = e.json;
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
      const result = f.mount(SESSION) as any;
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
      const result = f.mount(SESSION) as any;
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
