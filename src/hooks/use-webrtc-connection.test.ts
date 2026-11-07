// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

// Isolate the hook and browser globals per test without adding a DOM dependency.
// The hook runner preserves refs on rerender and runs effect cleanup before setup.
const bundle = await Bun.build({
  entrypoints: [import.meta.dir + '/use-webrtc-connection.ts'],
  target: 'browser',
  format: 'cjs',
  plugins: [{
    name: 'hook-runner',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        loader: 'js',
        contents: `
          let cursor = 0;
          const refs = [];
          export function useRef(value) { return refs[cursor++] ??= { current: value }; }
          export function useState(value) {
            const ref = useRef(value);
            return [ref.current, next => { ref.current = next; stateWrites.push(next); }];
          }
          export function useEffect(effect) { effects.push(effect); }
          globalThis.resetCursor = () => { cursor = 0; };
        `,
      }));
    },
  }],
});
if (!bundle.success) throw new Error('Could not bundle hook fixture', { cause: bundle.logs });
const code = await bundle.outputs[0].text();
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const event = (message: object) => ({ data: JSON.stringify(message) });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const sockets: FakeSocket[] = [];
  const peers: FakePeer[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const setTimer = (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; };
  const clearTimer = (id: number) => { timers.delete(id); };
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    listeners = new Set<(event: { data: string }) => void>();
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => Promise<void>) | null = null;
    constructor() { sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    config() { for (const fn of this.listeners) fn(event({ type: 'rtcConfiguration', rtcConfiguration: {} })); }
    addEventListener(_name: string, fn: (event: { data: string }) => void) { this.listeners.add(fn); }
    removeEventListener(_name: string, fn: (event: { data: string }) => void) { this.listeners.delete(fn); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class FakeChannel {
    closed = false;
    onopen = () => {};
    onclose = () => {};
    onerror = () => {};
    close() { this.closed = true; this.onclose(); }
  }
  class FakePeer {
    closed = false;
    connectionState = 'new';
    channels: FakeChannel[] = [];
    offer = deferred<{ sdp: string }>();
    local = deferred();
    remote = deferred();
    ice = deferred();
    localCalls = 0;
    iceCalls = 0;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange = () => {};
    onicecandidate = (_event: object) => {};
    ontrack = (_event: object) => {};
    constructor() { peers.push(this); }
    addTransceiver() { return { receiver: {} }; }
    createDataChannel() { const c = new FakeChannel(); this.channels.push(c); return c; }
    createOffer() { return this.offer.promise; }
    setLocalDescription() { this.localCalls++; return this.local.promise; }
    setRemoteDescription() { return this.remote.promise; }
    addIceCandidate() { this.iceCalls++; return this.ice.promise; }
    setConfiguration() {}
    close() { this.closed = true; this.onconnectionstatechange?.(); }
  }
  const stateWrites: boolean[] = [];
  const states: boolean[] = [];
  const failures: boolean[] = [];
  const bindings: (FakePeer | null)[] = [];
  const effects: (() => () => void)[] = [];
  const video = { current: { srcObject: null, muted: true } };
  const context = {
    module: { exports: {} as { useWebRtcConnection: (options: object) => { wsRef: { current: FakeSocket | null } } } },
    window: { setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setTimer, clearInterval: clearTimer },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    WebSocket: FakeSocket, RTCPeerConnection: FakePeer,
    RTCRtpReceiver: { getCapabilities: () => null },
    RTCSessionDescription: class { constructor(value: object) { Object.assign(this, value); } },
    RTCIceCandidate: class { constructor(value: object) { Object.assign(this, value); } },
    setTimeout: setTimer, clearTimeout: clearTimer,
    console, stateWrites, effects, resetCursor: () => {},
  };
  runInNewContext(code, context);
  let cleanup = () => {};
  const mount = (id = 'a', openUrl?: string) => {
    cleanup();
    context.resetCursor();
    effects.length = 0;
    const result = context.module.exports.useWebRtcConnection({
      url: 'wss://example.invalid/' + id, sessionId: id, videoRef: video, openUrl,
      onConnectionStateChange: (state: boolean) => states.push(state),
      onConnectionFailed: () => failures.push(true),
      onPeerConnectionChange: (pc: FakePeer | null) => bindings.push(pc),
    });
    const cleanups = effects.map(fn => fn());
    cleanup = () => { cleanups.forEach(fn => fn()); cleanup = () => {}; };
    return result;
  };
  return {
    sockets, peers, timers, states, failures, bindings, stateWrites, video, mount,
    unmount: () => cleanup(),
    fireTimers() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(fn => fn()); },
    async negotiate(openUrl?: string) { mount('a', openUrl); sockets[0].open(); await tick(); sockets[0].config(); await tick(); },
  };
}

for (const end of ['unmount', 'switch'] as const) {
  for (const boundary of ['open', 'config', 'offer', 'local'] as const) {
    test(`${end} cancels stale ${boundary} continuation`, async () => {
      const f = fixture();
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
  const f = fixture();
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
  const f = fixture();
  await f.negotiate('https%3A%2F%2Fexample.invalid');
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
    const f = fixture(); await f.negotiate();
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
  const f = fixture(); await f.negotiate();
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
  const f = fixture(); f.mount('a', 'https%3A%2F%2Fexample.invalid');
  f.sockets[0].open(); await tick(); f.sockets[0].config(); await tick();
  f.peers[0].channels[0].onopen(); f.fireTimers();
  expect(f.sockets[0].sent.filter(m => m.type === 'requestFrame')).toHaveLength(12);
  expect(f.sockets[0].sent.find(m => m.type === 'openUrl')?.url).toBe('https://example.invalid');
  f.unmount();
});

test('stop between socket resolution and its continuation prevents a configuration request', async () => {
  const f = fixture(); f.mount();
  f.sockets[0].open();
  f.unmount();
  await tick();
  expect(f.sockets[0].sent).toEqual([]);
  expect(f.peers).toEqual([]);
  expect(f.failures).toEqual([]);
});

test('late remote description cannot mark the replacement ready for ICE', async () => {
  const f = fixture(); await f.negotiate();
  const oldAnswer = f.sockets[0].onmessage!(event({ type: 'answer', sdp: 'old' }));
  f.mount('b'); f.sockets[1].open(); await tick(); f.sockets[1].config(); await tick();
  f.peers[0].remote.resolve(); await oldAnswer;
  await f.sockets[1].onmessage!(event({ type: 'candidate', candidate: 'new' }));
  expect(f.peers[1].iceCalls).toBe(0);
  f.unmount();
});

for (const phase of ['open', 'config'] as const) {
  test(`current ${phase} timeout reports failure and clears startup resources`, async () => {
    const f = fixture(); f.mount();
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
  const f = fixture(); await f.negotiate();
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
