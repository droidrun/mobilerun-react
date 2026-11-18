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

test('provider per socket awaits a fresh key for first connect and retry', async () => {
  const f = await fixture();
  const first = deferred<string>();
  const second = deferred<string>();
  const keys = [first, second];
  let calls = 0;
  const tokenProvider = () => keys[calls++].promise;
  f.mount('a', undefined, { token: 'legacy-static', tokenProvider });
  await tick();
  expect(calls).toBe(1);
  expect(f.sockets).toEqual([]);
  first.resolve('first key');
  await tick();
  expect(f.sockets[0].url).toBe('wss://example.invalid/a?token=first+key');
  f.sockets[0].close(1006);
  await tick();
  expect(f.failures).toEqual([true]);
  f.mount('a', undefined, { tokenProvider });
  await tick();
  expect(calls).toBe(2);
  expect(f.sockets).toHaveLength(1);
  second.resolve('second-key');
  await tick();
  expect(f.sockets[1].url).toBe('wss://example.invalid/a?token=second-key');
  f.unmount();
});

test.each([
  ['reject', (): Promise<string> => Promise.reject(new Error('refused'))],
  ['empty', async (): Promise<string> => ''],
  ['whitespace', async (): Promise<string> => '  '],
] as const)('mint failure %s never falls back', async (_failure, tokenProvider) => {
  const f = await fixture();
  f.mount('a', undefined, { token: 'legacy-static', tokenProvider });
  await tick();
  expect(f.failures).toEqual([true]);
  expect(f.sockets).toEqual([]);
  f.fireTimers();
  await tick();
  expect(f.failures).toEqual([true]);
  f.unmount();
});

test('stale mint after unmount has no socket, failure or state write', async () => {
  const f = await fixture();
  const mint = deferred<string>();
  f.mount('a', undefined, { tokenProvider: () => mint.promise });
  f.unmount();
  const writes = f.stateWrites.length;
  mint.resolve('abandoned');
  await tick();
  expect(f.sockets).toEqual([]);
  expect(f.failures).toEqual([]);
  expect(f.stateWrites).toHaveLength(writes);
});

test('stale mint after device switch cannot replace the current socket', async () => {
  const f = await fixture();
  const mint = deferred<string>();
  f.mount('a', undefined, { tokenProvider: () => mint.promise });
  f.render('b', undefined, { tokenProvider: async () => 'device-b' });
  await tick();
  const writes = f.stateWrites.length;
  mint.resolve('device-a');
  await tick();
  expect(f.sockets.map(ws => ws.url)).toEqual(['wss://example.invalid/b?token=device-b']);
  expect(f.failures).toEqual([]);
  expect(f.stateWrites).toHaveLength(writes);
  f.unmount();
});

test('effect restart ignores a late rejected mint', async () => {
  const f = await fixture();
  const mint = deferred<string>();
  f.mount('a', undefined, { tokenProvider: () => mint.promise });
  f.mount('a', undefined, { tokenProvider: async () => 'restarted' });
  await tick();
  const writes = f.stateWrites.length;
  mint.reject(new Error('stale refusal'));
  await tick();
  expect(f.sockets.map(ws => ws.url)).toEqual(['wss://example.invalid/a?token=restarted']);
  expect(f.failures).toEqual([]);
  expect(f.stateWrites).toHaveLength(writes);
  f.unmount();
});

test.each([1001, 1006])('provider close %i tears down connected media before retry', async (code) => {
  const f = await fixture();
  let calls = 0;
  const tokenProvider = async () => `key-${++calls}`;
  f.mount('a', undefined, { tokenProvider });
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  const pc = f.peers[0];
  pc.connectionState = 'connected';
  pc.onconnectionstatechange!();
  pc.ontrack({ track: { kind: 'video' } });
  const media = f.video.current.srcObject!;
  expect(media.getTracks()).toHaveLength(1);
  const lateClose = f.sockets[0].onclose!;
  f.sockets[0].close(code);
  lateClose({ code });
  await tick();
  expect(pc.closed).toBe(true);
  expect(pc.channels.map(c => c.closed)).toEqual([true, true]);
  expect(f.video.current.srcObject).toBeNull();
  expect(media.getTracks()).toEqual([]);
  expect(f.stateWrites.at(-1)).toBe(false);
  expect(f.failures).toEqual([true]);
  expect(f.bindings.at(-1)).toBeNull();
  f.mount('a', undefined, { tokenProvider });
  await tick();
  expect(calls).toBe(2);
  expect(f.sockets[1].url).toBe('wss://example.invalid/a?token=key-2');
  f.unmount();
});

test('provider ICE refresh reuses the existing socket without minting', async () => {
  const f = await fixture();
  let calls = 0;
  const tokenProvider = async () => {
    calls++;
    return 'one-key';
  };
  f.mount('a', undefined, { tokenProvider });
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  const pc = f.peers[0];
  pc.offer.resolve({ sdp: 'initial' });
  pc.local.resolve();
  await tick();
  const refresh = { type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } };
  await f.sockets[0].onmessage!(event(refresh));
  expect(calls).toBe(1);
  expect(f.sockets).toHaveLength(1);
  expect(pc.configArgs).toEqual([{ iceServers: [] }]);
  expect(f.sockets[0].sent.filter(m => m.type === 'offer')).toHaveLength(2);
  f.unmount();
});

test('provider startup keeps visibility and keepalive bound to the eventual socket', async () => {
  const f = await fixture();
  const mint = deferred<string>();
  f.mount('a', undefined, { tokenProvider: () => mint.promise });
  await tick();
  f.document.hidden = true;
  f.visibilityChange();
  mint.resolve('fresh');
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  expect(f.scheduled.filter(t => t.kind === 'interval')).toEqual([]);
  f.document.hidden = false;
  f.visibilityChange();
  f.fireTimers();
  expect(f.sockets[0].sent.filter(m => m.type === 'keepAlive')).toEqual([
    { type: 'keepAlive', sessionId: 'a' },
  ]);
  f.unmount();
});

test('legacy token compatibility keeps synchronous startup and media after signaling close', async () => {
  const f = await fixture();
  f.mount('a', undefined, { token: 'legacy-static' });
  expect(f.sockets[0].url).toBe('wss://example.invalid/a?token=legacy-static');
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  f.peers[0].connectionState = 'connected';
  f.peers[0].onconnectionstatechange!();
  f.sockets[0].close(1001);
  await tick();
  expect(f.peers[0].closed).toBe(false);
  expect(f.failures).toEqual([]);
  f.unmount();
});
