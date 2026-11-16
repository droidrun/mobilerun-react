// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { runHook, tick } from './test-hook-runner';

export const event = (message: object) => ({ data: JSON.stringify(message) });

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function fixture() {
  const sockets: FakeSocket[] = [];
  const peers: FakePeer[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  // Every scheduled delay, in order, so tests can check timings the fake never waits out.
  const scheduled: { kind: 'timeout' | 'interval'; ms: number }[] = [];
  const schedule = (kind: 'timeout' | 'interval') => (fn: () => void, ms: number) => {
    scheduled.push({ kind, ms });
    timers.set(++nextTimer, fn);
    return nextTimer;
  };
  const setTimer = schedule('timeout');
  const setIntervalTimer = schedule('interval');
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
    channelOptions: { label: string; options: Record<string, unknown> }[] = [];
    offer = deferred<{ sdp: string }>();
    local = deferred();
    remote = deferred();
    ice = deferred();
    localCalls = 0;
    iceCalls = 0;
    remoteArgs: Record<string, unknown>[] = [];
    iceArgs: Record<string, unknown>[] = [];
    configArgs: Record<string, unknown>[] = [];
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange = () => {};
    onicecandidate = (_event: object) => {};
    ontrack = (_event: object) => {};
    constructor() { peers.push(this); }
    addTransceiver() { return { receiver: {} }; }
    createDataChannel(label: string, options: Record<string, unknown>) { this.channelOptions.push({ label, options }); const c = new FakeChannel(); this.channels.push(c); return c; }
    createOffer() { return this.offer.promise; }
    setLocalDescription() { this.localCalls++; return this.local.promise; }
    setRemoteDescription(arg: Record<string, unknown>) { this.remoteArgs.push(arg); return this.remote.promise; }
    addIceCandidate(arg: Record<string, unknown>) { this.iceArgs.push(arg); this.iceCalls++; return this.ice.promise; }
    setConfiguration(arg: Record<string, unknown>) { this.configArgs.push(arg); }
    close() { this.closed = true; this.onconnectionstatechange?.(); }
  }
  const stateWrites: boolean[] = [];
  const states: boolean[] = [];
  const failures: boolean[] = [];
  const bindings: (FakePeer | null)[] = [];
  const video = { current: { srcObject: null, muted: true } };
  const context = {
    window: { setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setIntervalTimer, clearInterval: clearTimer },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    WebSocket: FakeSocket, RTCPeerConnection: FakePeer,
    RTCRtpReceiver: { getCapabilities: () => null },
    RTCSessionDescription: class { constructor(value: object) { Object.assign(this, value); } },
    RTCIceCandidate: class { constructor(value: object) { Object.assign(this, value); } },
    setTimeout: setTimer, clearTimeout: clearTimer,
    console, stateWrites,
  };
  const runner = await runHook<{ useWebRtcConnection: (options: object) => { wsRef: { current: FakeSocket | null } } }>(
    import.meta.dir + '/use-webrtc-connection.ts', context, { compareEffectDeps: false },
  );
  const mount = (id = 'a', openUrl?: string) => {
    runner.unmount();
    runner.beginRender();
    const result = runner.module.exports.useWebRtcConnection({
      url: 'wss://example.invalid/' + id, sessionId: id, videoRef: video, openUrl,
      onConnectionStateChange: (state: boolean) => states.push(state),
      onConnectionFailed: () => failures.push(true),
      onPeerConnectionChange: (pc: FakePeer | null) => bindings.push(pc),
    });
    runner.flushEffects();
    return result;
  };
  return {
    sockets, peers, timers, scheduled, states, failures, bindings, stateWrites, video, mount,
    unmount: runner.unmount,
    fireTimers() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(fn => fn()); },
    async negotiate(id = 'a', openUrl?: string) { mount(id, openUrl); sockets[0].open(); await tick(); sockets[0].config(); await tick(); },
  };
}
