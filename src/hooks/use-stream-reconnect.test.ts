// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from 'bun:test';
import { FakeSchedule } from '../lib/test-clock';
import type { StreamError, StreamFailure } from '../lib/stream-error';
import { runHook, tick } from './test-hook-runner';
import { fixture } from './webrtc-test-fixture';
import type { useStreamReconnect } from './use-stream-reconnect';

async function reconnectFixture(online = true, enabled = true) {
  const clock = new FakeSchedule();
  const navigator = { onLine: online };
  const listeners = { online: new Set<() => void>(), offline: new Set<() => void>(), visibilitychange: new Set<() => void>() };
  const events = {
    addEventListener(name: keyof typeof listeners, fn: () => void) { listeners[name].add(fn); },
    removeEventListener(name: keyof typeof listeners, fn: () => void) { listeners[name].delete(fn); },
  };
  const heal = mock(() => {});
  const error = mock((_error: StreamError) => {});
  const runner = await runHook<{ useStreamReconnect: typeof useStreamReconnect<string> }>(
    import.meta.dir + '/use-stream-reconnect.ts', {
      navigator, window: events, document: { ...events, visibilityState: 'visible' },
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      Math: { ...Math, random: () => 0.5, min: Math.min, max: Math.max, round: Math.round },
    },
  );
  const render = (target = 'a', onHeal = heal, commit = true) => {
    runner.beginRender();
    const result = runner.module.exports.useStreamReconnect({
      target, targetKey: target, enabled, watchdogFromSocket: true, onHeal, onError: error,
    });
    if (commit) runner.flushEffects();
    return result;
  };
  const network = (available: boolean) => {
    navigator.onLine = available;
    listeners[available ? 'online' : 'offline'].forEach(fn => fn());
  };
  return { clock, listeners, heal, error, render, network, navigator, commit: runner.flushEffects, unmount: runner.unmount };
}

test('initial offline, target change and visibility wait for one fresh online attempt', async () => {
  const r = await reconnectFixture(false);
  const f = await fixture();
  f.networkChange(false);
  let result = r.render();
  const provider = mock(async () => 'fresh');
  f.mount(result.activeTarget, undefined, { tokenProvider: provider });
  r.listeners.visibilitychange.forEach(fn => fn());
  r.render('b');
  result = r.render('b'); // Settle React's render-phase target update.
  r.clock.advance(45_001);
  await tick();
  expect(result.streamKey).toBe('1');
  expect(result.activeTarget).toBe('b');
  expect(provider).not.toHaveBeenCalled();
  expect(f.sockets).toHaveLength(0);
  expect(r.error).not.toHaveBeenCalled();
  r.network(true);
  r.network(true);
  r.listeners.visibilitychange.forEach(fn => fn());
  result = r.render('b');
  f.networkChange(true);
  f.mount(result.activeTarget, undefined, { tokenProvider: provider });
  await tick();
  expect(result.streamKey).toBe('2');
  expect(result.activeTarget).toBe('b');
  expect(result.attempt).toBe(0);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sockets).toHaveLength(1);
  expect(r.heal).toHaveBeenCalledTimes(1);
  r.unmount();
  f.unmount();
  expect(r.listeners.online.size + r.listeners.offline.size + r.listeners.visibilitychange.size).toBe(0);
});

test('network return resets high backoff, uses latest callback and ignores the old child', async () => {
  const r = await reconnectFixture();
  let result = r.render();
  result.onConnectionFailed();
  r.clock.advance(1_000);
  result = r.render();
  result.onConnectionFailed();
  r.clock.advance(2_000);
  result = r.render();
  result.onConnectionFailed();
  result = r.render();
  expect(result.attempt).toBe(3);
  const stale = result;
  const latestHeal = mock(() => {});
  r.network(false);
  r.listeners.visibilitychange.forEach(fn => fn());
  r.render('new', latestHeal);
  r.render('new', latestHeal);
  r.clock.advance(60_000);
  await tick();
  r.network(true);
  result = r.render('new', latestHeal);
  stale.onConnectionFailed();
  stale.onConnectionStateChange(true);
  stale.onConnectionAttemptStarted();
  r.network(true);
  result = r.render('new', latestHeal);
  expect(result.streamKey).toBe('4');
  expect(result.activeTarget).toBe('new');
  expect(result.attempt).toBe(0);
  expect(result.status).toBe('reconnecting');
  expect(latestHeal).toHaveBeenCalledTimes(1);
  expect(r.error).toHaveBeenCalledTimes(3);
  expect(r.clock.pendingCount).toBe(0);
  r.unmount();
});

test('connected hook survives offline/online and detached observers cannot revive it', async () => {
  const r = await reconnectFixture();
  let result = r.render();
  result.onConnectionStateChange(true);
  r.network(false);
  r.network(true);
  result = r.render();
  expect(result.streamKey).toBe('0');
  expect(result.status).toBe('connected');
  expect(r.heal).not.toHaveBeenCalled();
  r.network(false);
  const lateOnline = [...r.listeners.online][0]!;
  r.unmount();
  lateOnline();
  r.clock.advance(60_000);
  expect(r.heal).not.toHaveBeenCalled();
  expect(r.clock.pendingCount).toBe(0);
});

test('online with no target asks the discovery owner to refresh once', async () => {
  const r = await reconnectFixture(false, false);
  r.render();
  r.network(true);
  r.network(true);
  expect(r.heal).toHaveBeenCalledTimes(1);
  expect(r.render().streamKey).toBe('0');
  r.unmount();
});

test('offline switch from connected A to B tears down A and acquires B once on return', async () => {
  const r = await reconnectFixture();
  const f = await fixture();
  const provider = mock(async () => 'fresh');
  let result = r.render();
  f.mount(result.activeTarget, undefined, { tokenProvider: provider });
  await tick();
  f.sockets[0].open();
  await tick();
  f.sockets[0].config();
  await tick();
  const oldPeer = f.peers[0];
  oldPeer.connectionState = 'connected';
  oldPeer.onconnectionstatechange!();
  result.onConnectionStateChange(true);
  r.network(false);
  f.networkChange(false);
  r.render('b');
  r.render('b');
  result = r.render('b'); // Observe the snapshot emitted by the new mount's layout effect.
  expect(result.activeTarget).toBe('b');
  expect(result.status).toBe('connecting');
  f.mount(result.activeTarget, undefined, { tokenProvider: provider });
  await tick();
  expect(oldPeer.closed).toBe(true);
  expect(oldPeer.channels.map(channel => channel.closed)).toEqual([true, true]);
  expect(f.sockets[0].readyState).toBe(3);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sockets).toHaveLength(1);
  r.network(true);
  f.networkChange(true);
  result = r.render('b');
  f.mount(result.activeTarget, undefined, { tokenProvider: provider });
  await tick();
  expect(result.attempt).toBe(0);
  expect(result.status).toBe('reconnecting');
  expect(result.streamKey).toBe('2');
  expect(provider).toHaveBeenCalledTimes(2);
  expect(f.sockets).toHaveLength(2);
  expect(f.sockets[1].url).toContain('/b?');
  r.unmount();
  f.unmount();
});

test('offline render followed by online commit starts one provider call without remount', async () => {
  const r = await reconnectFixture(false);
  const f = await fixture();
  const provider = mock(async () => 'fresh');
  r.render('a', r.heal, false);
  r.navigator.onLine = true;
  r.commit();
  const result = r.render();
  f.mount(result.activeTarget, undefined, { tokenProvider: provider, onConnectionAttemptStarted: result.onConnectionAttemptStarted });
  await tick();
  expect(result.streamKey).toBe('0');
  expect(result.status).toBe('connecting');
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sockets).toHaveLength(1);
  expect(r.heal).not.toHaveBeenCalled();
  expect(r.clock.pendingCount).toBe(1); // The one allocated socket owns its watchdog.
  r.unmount();
  f.unmount();
});

test('explicit Retry offline opens once, reports one failure and resumes once online', async () => {
  const r = await reconnectFixture(false);
  const f = await fixture();
  f.networkChange(false);
  const provider = mock(async () => 'fresh');
  let result = r.render();
  f.mount(result.activeTarget, undefined, { tokenProvider: provider, allowOffline: result.allowOffline });
  r.listeners.visibilitychange.forEach(fn => fn());
  r.clock.advance(60_000);
  await tick();
  expect(provider).not.toHaveBeenCalled();
  expect(f.sockets).toHaveLength(0);
  result.retry();
  result = r.render();
  f.mount(result.activeTarget, undefined, {
    tokenProvider: provider, allowOffline: result.allowOffline,
    onConnectionAttemptStarted: result.onConnectionAttemptStarted,
  });
  await tick();
  expect(result.streamKey).toBe('1');
  expect(result.allowOffline).toBe(true);
  expect(result.attempt).toBe(0);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sockets).toHaveLength(1);
  expect(r.clock.pendingCount).toBe(1);
  f.sockets[0].close(1006);
  await tick();
  result.onConnectionFailed(f.failureInfos[0] as StreamFailure);
  result.onConnectionFailed(f.failureInfos[0] as StreamFailure);
  result = r.render();
  expect(r.error.mock.calls).toEqual([[{
    reason: 'connection_refused', message: 'Signaling connection closed before it opened', attempt: 1, final: false,
  }]]);
  expect(r.clock.pendingCount).toBe(0);
  r.listeners.visibilitychange.forEach(fn => fn());
  r.clock.advance(60_000);
  await tick();
  expect(r.render().streamKey).toBe('1');
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sockets).toHaveLength(1);
  r.network(true);
  f.networkChange(true);
  result = r.render();
  f.mount(result.activeTarget, undefined, { tokenProvider: provider, allowOffline: result.allowOffline });
  await tick();
  r.network(true);
  r.listeners.visibilitychange.forEach(fn => fn());
  expect(result.streamKey).toBe('2');
  expect(result.allowOffline).toBe(false);
  expect(result.attempt).toBe(0);
  expect(provider).toHaveBeenCalledTimes(2);
  expect(f.sockets).toHaveLength(2);
  r.unmount();
  f.unmount();
});

test('an automatic target change cannot reuse the explicit offline Retry permission', async () => {
  const r = await reconnectFixture(false);
  const f = await fixture();
  f.networkChange(false);
  const provider = mock(async () => 'fresh');
  let result = r.render();
  result.retry();
  result = r.render();
  f.mount(result.activeTarget, undefined, { tokenProvider: provider, allowOffline: result.allowOffline });
  await tick();
  expect(provider).toHaveBeenCalledTimes(1);
  r.render('b');
  result = r.render('b');
  f.mount(result.activeTarget, undefined, { tokenProvider: provider, allowOffline: result.allowOffline });
  await tick();
  expect(result.allowOffline).toBe(false);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sockets).toHaveLength(1);
  expect(f.sockets[0].readyState).toBe(3);
  r.unmount();
  f.unmount();
});
