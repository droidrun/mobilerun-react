// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test';
import { tick } from './test-hook-runner';
import { deferred, event, fixture } from './webrtc-test-fixture';

for (const end of ['unmount', 'switch'] as const) {
  for (const boundary of ['open', 'config', 'offer', 'local'] as const) {
    test(`${end} cancels stale ${boundary} continuation`, async () => {
      const f = await fixture();
      f.mount();
      const ws = f.sockets[0];
      const lateOpen = ws.onopen!;
      if (boundary !== 'open') { ws.open(); await tick(); }
      if (boundary !== 'open') ws.config();
      if (boundary === 'offer' || boundary === 'local') await tick();
      const pc = f.peers[0];
      if (boundary === 'local') { pc.offer.resolve({ sdp: 'old' }); await tick(); }
      if (end === 'unmount') f.unmount(); else f.mount('b');
      if (boundary === 'open') lateOpen();
      if (boundary === 'offer') pc.offer.resolve({ sdp: 'old' });
      if (boundary === 'local') pc.local.resolve();
      await tick();
      expect(ws.readyState).toBe(3);
      expect(ws.listeners.size).toBe(0);
      expect(f.peers.every(p => p.closed && p.channels.every(c => c.closed))).toBe(true);
      expect(f.sockets.flatMap(s => s.sent).some(m => m.type === 'offer')).toBe(false);
      if (boundary === 'offer') expect(pc.localCalls).toBe(0);
      expect(f.failures).toEqual([]);
      f.unmount();
      expect(f.timers.size).toBe(0);
    });
  }
}

test('stop removes a pending configuration listener and both startup deadlines', async () => {
  const f = await fixture();
  f.mount();
  const openDeadline = [...f.timers.values()][0];
  f.sockets[0].open(); await tick();
  expect([...f.timers.values()]).not.toContain(openDeadline);
  const listener = [...f.sockets[0].listeners][0];
  const queued = [...f.timers.values()];
  f.unmount();
  expect(f.timers.size).toBe(0);
  expect(f.sockets[0].listeners.size).toBe(0);
  listener(event({ type: 'rtcConfiguration', rtcConfiguration: {} }));
  queued.forEach(fn => fn());
  await tick();
  expect(f.peers).toEqual([]);
  expect(f.failures).toEqual([]);
});

test('stale channel, peer, socket callbacks and queued frame requests are silent', async () => {
  const f = await fixture();
  await f.negotiate('a', 'https%3A%2F%2Fexample.invalid');
  const ws = f.sockets[0], pc = f.peers[0];
  const lateMessage = ws.onmessage!;
  pc.channels[0].onopen();
  const queued = [...f.timers.values()];
  const callbacks = [ws.onclose!, ws.onerror!, pc.onconnectionstatechange!, pc.oniceconnectionstatechange,
    ...pc.channels.flatMap(c => [c.onopen, c.onclose, c.onerror])];
  f.mount('b'); f.sockets[1].open(); await tick();
  const counts = [f.stateWrites.length, f.states.length, f.bindings.length];
  const sends = f.sockets.map(s => s.sent.length);
  callbacks.forEach(fn => fn());
  pc.ontrack({ track: { kind: 'video' } });
  pc.onicecandidate({ candidate: { candidate: 'old' } });
  queued.forEach(fn => fn());
  await lateMessage(event({ type: 'screenshot', id: 'old', dataUri: 'old' }));
  expect(f.sockets.map(s => s.sent.length)).toEqual(sends);
  expect([f.stateWrites.length, f.states.length, f.bindings.length]).toEqual(counts);
  expect(f.video.current.srcObject).toBeNull();
  expect(f.failures).toEqual([]);
  f.unmount();
});

for (const boundary of ['offer', 'local', 'reject'] as const) {
  test(`current offer succeeds; stale ICE restart at ${boundary} is cancelled`, async () => {
    const f = await fixture(); await f.negotiate();
    const ws = f.sockets[0], pc = f.peers[0];
    pc.offer.resolve({ sdp: 'initial' }); await tick(); pc.local.resolve(); await tick();
    expect(ws.sent.some(m => m.type === 'offer' && m.sdp === 'initial')).toBe(true);
    pc.offer = deferred(); pc.local = deferred();
    const restart = ws.onmessage!(event({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } }));
    if (boundary === 'local') { pc.offer.resolve({ sdp: 'restart' }); await tick(); }
    f.mount('b');
    if (boundary === 'reject') pc.offer.reject(new Error('closed'));
    else if (boundary === 'offer') pc.offer.resolve({ sdp: 'restart' });
    else pc.local.resolve();
    await restart;
    expect(pc.localCalls).toBe(boundary === 'local' ? 2 : 1);
    expect(f.sockets.flatMap(s => s.sent).some(m => m.sdp === 'restart')).toBe(false);
    expect(f.failures).toEqual([]);
    f.unmount();
  });
}

test('late answer and buffered ICE completion preserve the replacement candidate buffer', async () => {
  const f = await fixture(); await f.negotiate();
  const oldWs = f.sockets[0], oldPc = f.peers[0];
  await oldWs.onmessage!(event({ type: 'candidate', candidate: 'old' }));
  const oldAnswer = oldWs.onmessage!(event({ type: 'answer', sdp: 'old' }));
  oldPc.remote.resolve(); await tick();
  expect(oldPc.iceCalls).toBe(1);
  f.mount('b'); f.sockets[1].open(); await tick(); f.sockets[1].config(); await tick();
  const ws = f.sockets[1], pc = f.peers[1];
  await ws.onmessage!(event({ type: 'candidate', candidate: 'new' }));
  oldPc.ice.resolve(); await oldAnswer;
  const answer = ws.onmessage!(event({ type: 'answer', sdp: 'new' }));
  pc.remote.resolve(); await tick();
  expect(pc.iceCalls).toBe(1);
  pc.ice.resolve(); await answer;
  f.unmount();
});

test('current control channel sends frame requests and open URL on its own socket', async () => {
  const f = await fixture(); f.mount('a', 'https%3A%2F%2Fexample.invalid');
  f.sockets[0].open(); await tick(); f.sockets[0].config(); await tick();
  f.peers[0].channels[0].onopen(); f.fireTimers();
  expect(f.sockets[0].sent.filter(m => m.type === 'requestFrame')).toHaveLength(12);
  expect(f.sockets[0].sent.find(m => m.type === 'openUrl')?.url).toBe('https://example.invalid');
  f.unmount();
});

test('stop between socket resolution and its continuation prevents a configuration request', async () => {
  const f = await fixture(); f.mount();
  f.sockets[0].open();
  f.unmount();
  await tick();
  expect(f.sockets[0].sent).toEqual([]);
  expect(f.peers).toEqual([]);
  expect(f.failures).toEqual([]);
});

test('late remote description cannot mark the replacement ready for ICE', async () => {
  const f = await fixture(); await f.negotiate();
  const oldAnswer = f.sockets[0].onmessage!(event({ type: 'answer', sdp: 'old' }));
  f.mount('b'); f.sockets[1].open(); await tick(); f.sockets[1].config(); await tick();
  f.peers[0].remote.resolve(); await oldAnswer;
  await f.sockets[1].onmessage!(event({ type: 'candidate', candidate: 'new' }));
  expect(f.peers[1].iceCalls).toBe(0);
  f.unmount();
});

for (const phase of ['open', 'config'] as const) {
  test(`current ${phase} timeout reports failure and clears startup resources`, async () => {
    const f = await fixture(); f.mount();
    if (phase === 'config') { f.sockets[0].open(); await tick(); }
    f.fireTimers(); await tick();
    expect(f.failures).toEqual([true]);
    expect(f.sockets[0].listeners.size).toBe(0);
    expect(f.peers).toEqual([]);
    f.unmount();
    expect(f.timers.size).toBe(0);
  });
}

test('a queued ICE grace recheck cannot change replacement state', async () => {
  const f = await fixture(); await f.negotiate();
  const pc = f.peers[0];
  const restart = f.sockets[0].onmessage!(event({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } }));
  pc.connectionState = 'connecting'; pc.onconnectionstatechange!();
  const queued = [...f.timers.values()];
  f.mount('b');
  const count = f.stateWrites.length;
  queued.forEach(fn => fn());
  expect(f.stateWrites.length).toBe(count);
  pc.offer.resolve({ sdp: 'old' }); await restart;
  f.unmount();
});
