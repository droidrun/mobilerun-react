// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from 'bun:test';
import { createStreamReconnectController } from '../lib/stream-reconnect';
import { FakeSchedule } from '../lib/test-clock';
import { runHook, tick } from './test-hook-runner';
import type { UseDeviceStreamResult } from './use-device-stream';
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

test.each(['static', 'provider'] as const)(
  '%s close 1001 tears down connected media before retry', async (mode) => {
  const f = await fixture();
  let calls = 0;
  const tokenProvider = async () => `key-${++calls}`;
  const credentials = mode === 'provider' ? { tokenProvider } : { token: 'legacy-static' };
  f.mount('a', undefined, credentials);
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
  f.sockets[0].close(1001);
  lateClose({ code: 1001 });
  await tick();
  expect(pc.closed).toBe(true);
  expect(pc.channels.map(c => c.closed)).toEqual([true, true]);
  expect(f.video.current.srcObject).toBeNull();
  expect(media.getTracks()).toEqual([]);
  expect(f.stateWrites.at(-1)).toBe(false);
  expect(f.states).toEqual([true, false]);
  expect(f.states.at(-1)).toBe(false);
  expect(f.failures).toEqual([true]);
  expect(f.bindings.at(-1)).toBeNull();
  f.mount('a', undefined, credentials);
  await tick();
  expect(calls).toBe(mode === 'provider' ? 2 : 0);
  const expectedToken = mode === 'provider' ? 'key-2' : 'legacy-static';
  expect(f.sockets[1].url).toBe(`wss://example.invalid/a?token=${expectedToken}`);
  f.unmount();
});

test.each(['static', 'provider'] as const)(
  '%s close 1006 keeps connected media until retry', async (mode) => {
  const f = await fixture();
  let calls = 0;
  const tokenProvider = async () => `key-${++calls}`;
  const credentials = mode === 'provider' ? { tokenProvider } : { token: 'legacy-static' };
  f.mount('a', undefined, credentials);
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  const pc = f.peers[0];
  pc.connectionState = 'connected';
  pc.onconnectionstatechange!();
  pc.ontrack({ track: { kind: 'video' } });
  const media = f.video.current.srcObject;
  f.sockets[0].onerror!();
  f.sockets[0].close(1006);
  await tick();
  expect(pc.closed).toBe(false);
  expect(pc.channels.map(c => c.closed)).toEqual([false, false]);
  expect(f.video.current.srcObject).toBe(media);
  expect(f.failures).toEqual([]);
  expect(f.states).toEqual([true]);
  f.mount('a', undefined, credentials);
  await tick();
  expect(calls).toBe(mode === 'provider' ? 2 : 0);
  const expectedToken = mode === 'provider' ? 'key-2' : 'legacy-static';
  expect(f.sockets[1].url).toBe(`wss://example.invalid/a?token=${expectedToken}`);
  f.unmount();
});

test('provider peer failure reports disconnected once before teardown', async () => {
  const f = await fixture();
  f.mount('a', undefined, { tokenProvider: async () => 'key' });
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  const pc = f.peers[0];
  pc.connectionState = 'connected';
  pc.onconnectionstatechange!();
  pc.connectionState = 'failed';
  pc.onconnectionstatechange!();
  await tick();
  expect(f.states).toEqual([true, false]);
  expect(f.states.at(-1)).toBe(false);
  expect(pc.closed).toBe(true);
  expect(f.failures).toEqual([true]);
  f.unmount();
});

test('provider timeout fails at ten seconds and ignores a late key', async () => {
  const clock = new FakeSchedule();
  const f = await fixture(clock);
  const mint = deferred<string>();
  f.mount('a', undefined, { token: 'legacy-static', tokenProvider: () => mint.promise });
  clock.advance(9_999);
  await tick();
  expect(f.failures).toEqual([]);
  clock.advance(1);
  await tick();
  expect(f.failures).toEqual([true]);
  const writes = f.stateWrites.length;
  mint.resolve('too-late');
  await tick();
  expect(f.sockets).toEqual([]);
  expect(f.failures).toEqual([true]);
  expect(f.stateWrites).toHaveLength(writes);
  f.unmount();
});

test('provider phase leaves the full connect watchdog after socket allocation', async () => {
  const clock = new FakeSchedule();
  const f = await fixture(clock);
  const mint = deferred<string>();
  const controller = createStreamReconnectController({
    onRemount: () => {},
    onSnapshot: () => {},
    onHeal: () => {},
    schedule: clock,
  });
  controller.attemptMounted(false);
  f.mount('a', undefined, {
    tokenProvider: () => mint.promise,
    onConnectionAttemptStarted: () => controller.attemptMounted(),
  });
  expect(clock.pendingCount).toBe(1);
  clock.advance(9_999);
  mint.resolve('fresh');
  await tick();
  expect(f.sockets).toHaveLength(1);
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  clock.advance(35_001);
  expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
  clock.advance(9_998);
  expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
  clock.advance(1);
  expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
  controller.dispose();
  f.unmount();
});

test.each([
  'ws://stream.example.invalid/a',
  'https://stream.example.invalid/a',
  'ws://localhost.example.invalid/a',
])('provider rejects insecure URL %s before minting', async (url) => {
  const f = await fixture();
  const tokenProvider = mock(async () => 'key');
  f.mount('a', undefined, { url, tokenProvider });
  await tick();
  expect(f.failures).toEqual([true]);
  expect(tokenProvider).not.toHaveBeenCalled();
  expect(f.sockets).toEqual([]);
  f.unmount();
});

test.each([
  'ws://localhost:3000/a',
  'ws://127.0.0.1:3000/a',
  'ws://[::1]:3000/a',
])('provider allows loopback URL %s', async (url) => {
  const f = await fixture();
  const tokenProvider = mock(async () => 'key');
  f.mount('a', undefined, { url, tokenProvider });
  await tick();
  expect(tokenProvider).toHaveBeenCalledTimes(1);
  expect(f.sockets.map(ws => ws.url)).toEqual([`${url}?token=key`]);
  expect(f.failures).toEqual([]);
  f.unmount();
});

test('device switch during backoff cannot open the old URL with the new provider', async () => {
  const runner = await runHook<{ useDeviceStream: (options: unknown) => UseDeviceStreamResult }>(
    import.meta.dir + '/use-device-stream.ts',
  );
  const nextDevice = deferred<{ streamUrl: string }>();
  const client = { devices: { retrieve: mock()
    .mockResolvedValueOnce({ streamUrl: 'wss://example.invalid/a' })
    .mockImplementationOnce(() => nextDevice.promise) } };
  const readTarget = (deviceId: string) => {
    runner.beginRender();
    const result = runner.module.exports.useDeviceStream({ client, deviceId });
    runner.flushEffects();
    return result;
  };
  readTarget('a');
  await tick();
  let target = readTarget('a');
  const f = await fixture();
  const clock = new FakeSchedule();
  let tokenProvider = async () => 'key-a';
  const connect = () => {
    if (!target.streamUrl) return;
    f.mount('selected', undefined, { url: target.streamUrl, tokenProvider });
  };
  const controller = createStreamReconnectController({
    onRemount: connect,
    onSnapshot: () => {},
    onHeal: () => {},
    schedule: clock,
    random: () => 0.5,
  });
  connect();
  await tick();
  controller.attemptMounted();
  f.sockets[0].close(1006);
  await tick();
  controller.handleFailure();
  expect(controller.getSnapshot().status).toBe('reconnecting');
  target = readTarget('b');
  tokenProvider = async () => 'key-b';
  f.unmount();
  clock.advance(1_000);
  await tick();
  expect(f.sockets.map(ws => ws.url)).toEqual(['wss://example.invalid/a?token=key-a']);
  expect(target.device).toBeUndefined();
  expect(target.streamUrl).toBeUndefined();
  nextDevice.resolve({ streamUrl: 'wss://example.invalid/b' });
  await tick();
  target = readTarget('b');
  connect();
  await tick();
  expect(f.sockets[1].url).toBe('wss://example.invalid/b?token=key-b');
  controller.dispose();
  runner.unmount();
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
  f.sockets[0].close(1006);
  await tick();
  expect(f.peers[0].closed).toBe(false);
  expect(f.failures).toEqual([]);
  f.unmount();
});

// Failure reasons (stream client contract v1). The reason list lives in lib/stream-error.ts.
const reasons = (f: { failureInfos: { reason: string }[] }) => f.failureInfos.map(i => i.reason);

test.each([
  ['reject', (): Promise<string> => Promise.reject(new Error('refused'))],
  ['empty', async (): Promise<string> => ''],
] as const)('provider %s reports credentials_unavailable', async (_name, tokenProvider) => {
  const f = await fixture();
  f.mount('a', undefined, { tokenProvider });
  await tick();
  expect(reasons(f)).toEqual(['credentials_unavailable']);
  f.unmount();
});

test('provider timeout reports credentials_unavailable', async () => {
  const clock = new FakeSchedule();
  const f = await fixture(clock);
  f.mount('a', undefined, { tokenProvider: () => deferred<string>().promise });
  clock.advance(10_000);
  await tick();
  expect(reasons(f)).toEqual(['credentials_unavailable']);
  expect(f.failureInfos[0].message).toBe('Stream key provider failed');
  f.unmount();
});

test('a socket that closes before open reports connection_refused, with or without a provider', async () => {
  for (const credentials of [{ tokenProvider: async () => 'key' }, { token: 'legacy' }]) {
    const f = await fixture();
    f.mount('a', undefined, credentials);
    await tick();
    f.sockets[0].close(1006);
    await tick();
    expect(reasons(f)).toEqual(['connection_refused']);
    f.unmount();
  }
});

test('a socket that never opens is unknown, not a refusal', async () => {
  const clock = new FakeSchedule();
  const f = await fixture(clock);
  f.mount('a', undefined, { token: 'legacy' });
  await tick();
  clock.advance(15_000);
  await tick();
  expect(reasons(f)).toEqual(['unknown']);
  f.unmount();
});

test.each([
  ['server session end (1001)', 1001],
  ['abnormal close', 1006],
] as const)('an open socket dropped by %s reports disconnected', async (_name, code) => {
  const f = await fixture();
  f.mount('a', undefined, { tokenProvider: async () => 'key' });
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].close(code);
  await tick();
  expect(reasons(f)).toEqual(['disconnected']);
  expect(f.failureInfos[0].message).toContain(String(code));
  f.unmount();
});

test('peer failure is disconnected after it connected and unknown before', async () => {
  for (const [connectFirst, expected] of [[true, 'disconnected'], [false, 'unknown']] as const) {
    const f = await fixture();
    f.mount('a', undefined, { tokenProvider: async () => 'key' });
    await tick();
    f.sockets[0].open();
    await tick();
    f.sockets[0].config();
    await tick();
    const pc = f.peers[0];
    if (connectFirst) {
      pc.connectionState = 'connected';
      pc.onconnectionstatechange!();
    }
    pc.connectionState = 'failed';
    pc.onconnectionstatechange!();
    await tick();
    expect(reasons(f)).toEqual([expected]);
    f.unmount();
  }
});

test('every connect attempt calls the provider again and never reuses a key', async () => {
  const f = await fixture();
  let minted = 0;
  const tokenProvider = async () => `key-${++minted}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.mount('a', undefined, { tokenProvider });
    await tick();
    f.sockets[attempt - 1].close(1006);
    await tick();
  }
  expect(f.sockets.map(s => s.url)).toEqual([
    'wss://example.invalid/a?token=key-1',
    'wss://example.invalid/a?token=key-2',
    'wss://example.invalid/a?token=key-3',
  ]);
  expect(minted).toBe(3);
  f.unmount();
});

// Credential-free messages. The fixture shares one Error with the hook (as a browser does), so
// `e instanceof Error` is true here and a forwarded `message` would show up.
const MARKER = 'dr_st_SYNTHETIC_MARKER';

function expectNoCredential(f: { failureInfos: object[] }, onErrorPayloads: object[]) {
  for (const text of [JSON.stringify(f.failureInfos), JSON.stringify(onErrorPayloads)]) {
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('token=');
  }
}

function throughController(failures: { reason: string; message: string }[]) {
  const payloads: object[] = [];
  const controller = createStreamReconnectController({
    onRemount: () => {}, onHeal: () => {}, onSnapshot: () => {},
    onError: (error) => { payloads.push(error); },
    schedule: new FakeSchedule(),
  });
  controller.attemptMounted();
  controller.handleFailure(failures[0] as never);
  return payloads;
}

test.each([
  ['an Error naming the key', async () => { throw new Error('mint failed for ' + MARKER); }],
  ['an Error naming a token URL', async () => { throw new Error('GET https://api.invalid/stream?token=' + MARKER + ' 401'); }],
  ['a thrown string', async () => { throw 'token=' + MARKER; }],
] as const)('provider rejecting with %s never leaks its text', async (_name, tokenProvider) => {
  const f = await fixture();
  f.mount('a', undefined, { tokenProvider });
  await tick();
  expect(reasons(f)).toEqual(['credentials_unavailable']);
  expect(f.failureInfos[0].message).toBe('Stream key provider failed');
  expectNoCredential(f, throughController(f.failureInfos));
  f.unmount();
});

test.each([
  ['provider', { tokenProvider: async () => MARKER }],
  ['static token', { token: MARKER }],
] as const)('a socket constructor error carrying the token URL never leaks it (%s)', async (_name, credentials) => {
  const f = await fixture();
  f.hooks.onConstruct = (url) => { throw new Error('cannot open ' + url); };
  f.mount('a', undefined, credentials);
  await tick();
  expect(reasons(f)).toEqual(['unknown']);
  expect(f.failureInfos[0].message).toBe('Stream connection attempt failed');
  expectNoCredential(f, throughController(f.failureInfos));
  f.unmount();
});
