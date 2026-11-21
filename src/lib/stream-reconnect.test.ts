// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import {
  createStreamReconnectController,
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_RECONNECT_MAX_ATTEMPTS,
  STREAM_RECONNECT_STABILITY_MS,
  STREAM_RTC_CONFIG_TIMEOUT_MS,
  STREAM_WS_OPEN_TIMEOUT_MS,
  streamReconnectDelayMs,
  type StreamReconnectSnapshot,
} from './stream-reconnect';
import { reconnectPillLabel } from './stream-error';
import { FakeSchedule } from './test-clock';

// random() => 0.5 makes the jitter factor exactly 1.0.
const NO_JITTER = () => 0.5;
const DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function setup() {
  const schedule = new FakeSchedule();
  const calls = { remounts: 0, heals: 0 };
  const snapshots: StreamReconnectSnapshot[] = [];
  const controller = createStreamReconnectController({
    onRemount: () => {
      calls.remounts += 1;
    },
    onHeal: () => {
      calls.heals += 1;
    },
    onSnapshot: (s) => {
      snapshots.push(s);
    },
    schedule,
    random: NO_JITTER,
  });
  // Simulate React: every remount request results in a mounted attempt.
  const originalRemount = calls;
  return {
    schedule,
    calls: originalRemount,
    snapshots,
    controller,
    mountAndSettle() {
      controller.attemptMounted();
    },
  };
}

describe('streamReconnectDelayMs', () => {
  test('doubles from 1s and caps at 30s (no jitter)', () => {
    expect(DELAYS.map((_, i) => streamReconnectDelayMs(i + 1, NO_JITTER))).toEqual(DELAYS);
    expect(streamReconnectDelayMs(10, NO_JITTER)).toBe(30000);
  });

  test('jitter stays within ±25%', () => {
    expect(streamReconnectDelayMs(1, () => 0)).toBe(750);
    expect(streamReconnectDelayMs(1, () => 1)).toBe(1250);
  });
});

describe('connect watchdog', () => {
  test("exceeds the connection layer's own phase budgets", () => {
    // The WS-open and RTCConfiguration phases reject on their own; the
    // watchdog only backstops the phase after them (answer/ICE), which has
    // no self-timeout. A watchdog at or below the phases' sum would preempt
    // slow-but-valid handshakes the connection layer still considers on
    // budget — and on the final retry strand the stream in 'unavailable'
    // mid-handshake.
    expect(STREAM_CONNECT_TIMEOUT_MS).toBe(45_000);
    expect(STREAM_CONNECT_TIMEOUT_MS).toBeGreaterThan(
      STREAM_WS_OPEN_TIMEOUT_MS + STREAM_RTC_CONFIG_TIMEOUT_MS,
    );
  });

  test('a provider phase defers the watchdog but still counts its own failure', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted(false);
    expect(schedule.pendingCount).toBe(0);
    schedule.advance(10_000);
    expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
    controller.handleFailure();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
    controller.dispose();
  });

  test('an attempt that never connects fails after the timeout and schedules a retry', () => {
    const { schedule, calls, snapshots, controller } = setup();
    controller.attemptMounted();
    expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });

    schedule.advance(STREAM_CONNECT_TIMEOUT_MS);
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
    expect(calls.heals).toBe(1);
    expect(calls.remounts).toBe(0);

    schedule.advance(DELAYS[0]!);
    expect(calls.remounts).toBe(1);
    expect(snapshots.at(-1)).toEqual({ status: 'reconnecting', attempt: 1 });
  });

  test('terminal failure signal retries faster than the watchdog', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    schedule.advance(100);
    controller.handleFailure();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
    schedule.advance(DELAYS[0]!);
    expect(calls.remounts).toBe(1);
  });
});

describe('backoff escalation and exhaustion', () => {
  test('consecutive failures escalate delays and end unavailable', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();

    for (let i = 0; i < STREAM_RECONNECT_MAX_ATTEMPTS; i++) {
      controller.handleFailure();
      expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: i + 1 });
      // Nothing fires before the scheduled delay.
      schedule.advance(DELAYS[i]! - 1);
      expect(calls.remounts).toBe(i);
      schedule.advance(1);
      expect(calls.remounts).toBe(i + 1);
      controller.attemptMounted();
    }

    controller.handleFailure();
    expect(controller.getSnapshot()).toEqual({
      status: 'unavailable',
      attempt: STREAM_RECONNECT_MAX_ATTEMPTS + 1,
    });
    // No further retries scheduled.
    schedule.advance(10 * 60_000);
    expect(calls.remounts).toBe(STREAM_RECONNECT_MAX_ATTEMPTS);
    // Credentials are refetched once per recovery cycle, not per attempt.
    expect(calls.heals).toBe(1);
  });

  test('failure signals collapse into one backoff step per attempt', () => {
    const { controller } = setup();
    controller.attemptMounted();
    controller.handleFailure();
    controller.handleFailure();
    controller.handleDisconnected();
    expect(controller.getSnapshot().attempt).toBe(1);
  });
});

describe('disconnect handling', () => {
  test('non-connected states during negotiation are not failures', () => {
    const { controller } = setup();
    controller.attemptMounted();
    controller.handleDisconnected();
    controller.handleDisconnected();
    expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
  });

  test('a drop after connecting counts and reconnects', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    controller.handleConnected();
    expect(controller.getSnapshot()).toEqual({ status: 'connected', attempt: 0 });
    controller.handleDisconnected();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
    schedule.advance(DELAYS[0]!);
    expect(calls.remounts).toBe(1);
  });

  test('a stable connection refills the retry budget', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted();
    // Burn two attempts.
    controller.handleFailure();
    schedule.advance(DELAYS[0]!);
    controller.attemptMounted();
    controller.handleFailure();
    schedule.advance(DELAYS[1]!);
    controller.attemptMounted();

    controller.handleConnected();
    expect(controller.getSnapshot()).toEqual({ status: 'connected', attempt: 2 });
    schedule.advance(STREAM_RECONNECT_STABILITY_MS);
    expect(controller.getSnapshot()).toEqual({ status: 'connected', attempt: 0 });

    controller.handleDisconnected();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
  });

  test('a quick drop before stability keeps escalating', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted();
    controller.handleFailure();
    schedule.advance(DELAYS[0]!);
    controller.attemptMounted();
    controller.handleConnected();
    schedule.advance(1000); // well under the stability window
    controller.handleDisconnected();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 2 });
  });

  test('self-recovery during a backoff wait cancels the pending remount', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    controller.handleConnected();
    controller.handleDisconnected();
    expect(controller.getSnapshot().status).toBe('reconnecting');
    // The old peer connection comes back on its own before the timer fires.
    controller.handleConnected();
    expect(controller.getSnapshot().status).toBe('connected');
    schedule.advance(60_000);
    expect(calls.remounts).toBe(0);
  });
});

describe('wake and manual retry', () => {
  test('wake during a backoff wait retries immediately', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    controller.handleConnected();
    controller.handleDisconnected();
    controller.handleFailure(); // latched, no double count
    expect(calls.remounts).toBe(0);
    controller.handleWake();
    expect(calls.remounts).toBe(1);
    // The wait was consumed; once the new attempt connects nothing is pending
    // but the stability timer.
    controller.attemptMounted();
    controller.handleConnected();
    schedule.advance(60_000);
    expect(calls.remounts).toBe(1);
    expect(controller.getSnapshot()).toEqual({ status: 'connected', attempt: 0 });
  });

  test('wake while unavailable starts a fresh cycle', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    for (let i = 0; i <= STREAM_RECONNECT_MAX_ATTEMPTS; i++) {
      controller.handleFailure();
      schedule.advance(DELAYS[Math.min(i, DELAYS.length - 1)]!);
      if (i < STREAM_RECONNECT_MAX_ATTEMPTS) controller.attemptMounted();
    }
    expect(controller.getSnapshot().status).toBe('unavailable');
    const remountsBefore = calls.remounts;

    controller.handleWake();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 0 });
    expect(calls.remounts).toBe(remountsBefore + 1);
    controller.attemptMounted();
    controller.handleConnected();
    expect(controller.getSnapshot().status).toBe('connected');
  });

  test('retry() only acts when unavailable', () => {
    const { calls, controller } = setup();
    controller.attemptMounted();
    controller.retry();
    expect(calls.remounts).toBe(0);
    expect(controller.getSnapshot().status).toBe('connecting');
  });

  test('wake while connected is a no-op', () => {
    const { calls, controller } = setup();
    controller.attemptMounted();
    controller.handleConnected();
    controller.handleWake();
    expect(calls.remounts).toBe(0);
    expect(controller.getSnapshot().status).toBe('connected');
  });
});

describe('target changes', () => {
  test('applies target changes immediately while connected or connecting', () => {
    const { controller } = setup();
    controller.attemptMounted();
    expect(controller.shouldDeferTargetChange()).toBe(false);
    controller.handleConnected();
    expect(controller.shouldDeferTargetChange()).toBe(false);
  });

  test('defers target changes during a backoff wait and while unavailable', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted();
    controller.handleFailure();
    expect(controller.shouldDeferTargetChange()).toBe(true);
    schedule.advance(DELAYS[0]!);
    controller.attemptMounted();
    for (let i = 1; i <= STREAM_RECONNECT_MAX_ATTEMPTS; i++) {
      controller.handleFailure();
      schedule.advance(DELAYS[Math.min(i, DELAYS.length - 1)]!);
      if (i < STREAM_RECONNECT_MAX_ATTEMPTS) controller.attemptMounted();
    }
    expect(controller.getSnapshot().status).toBe('unavailable');
    expect(controller.shouldDeferTargetChange()).toBe(true);
  });

  test('applies credentials that arrive after the backoff to the in-flight retry', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted();
    controller.handleFailure(); // fires onHeal — async credential refetch starts
    // Refetch still pending during the wait: deferred.
    expect(controller.shouldDeferTargetChange()).toBe(true);
    schedule.advance(DELAYS[0]!);
    controller.attemptMounted();
    // Retry is in flight on stale credentials; the refetch resolves now. The
    // remount must not be swallowed or the attempt runs stale until the
    // watchdog fails it.
    expect(controller.shouldDeferTargetChange()).toBe(false);
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
  });

  test('applies credentials that arrive after wake to the in-flight fresh cycle', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted();
    for (let i = 0; i <= STREAM_RECONNECT_MAX_ATTEMPTS; i++) {
      controller.handleFailure();
      schedule.advance(DELAYS[Math.min(i, DELAYS.length - 1)]!);
      if (i < STREAM_RECONNECT_MAX_ATTEMPTS) controller.attemptMounted();
    }
    expect(controller.getSnapshot().status).toBe('unavailable');
    controller.handleWake(); // fires onHeal + remounts immediately
    controller.attemptMounted();
    expect(controller.shouldDeferTargetChange()).toBe(false);
  });

  test('a rotation remount flips connected back to connecting', () => {
    const { controller } = setup();
    controller.attemptMounted();
    controller.handleConnected();
    // Hook remounts on target change, then reports the mount.
    controller.attemptMounted();
    expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
  });
});

describe('disable and dispose', () => {
  test('disabling stops timers and resets state', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    controller.handleFailure();
    controller.setDisabled();
    expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
    schedule.advance(10 * 60_000);
    expect(calls.remounts).toBe(0);
    // Signals are ignored while disabled.
    controller.handleFailure();
    expect(controller.getSnapshot()).toEqual({ status: 'connecting', attempt: 0 });
  });

  test('dispose clears all pending timers', () => {
    const { schedule, controller } = setup();
    controller.attemptMounted();
    controller.handleFailure();
    controller.dispose();
    expect(schedule.pendingCount).toBe(0);
  });

  test('a StrictMode-style mount during a wait does not disturb it', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();
    controller.handleConnected();
    controller.handleDisconnected();
    controller.attemptMounted(); // spurious remount notification mid-wait
    schedule.advance(DELAYS[0]! - 1);
    expect(calls.remounts).toBe(0);
    schedule.advance(1);
    expect(calls.remounts).toBe(1);
  });
});

describe('heal cadence', () => {
  test('one heal per recovery cycle, again after stability reset and on wake', () => {
    const { schedule, calls, controller } = setup();
    controller.attemptMounted();

    // Cycle 1: only the first failure heals.
    controller.handleFailure();
    expect(calls.heals).toBe(1);
    schedule.advance(DELAYS[0]!);
    controller.attemptMounted();
    controller.handleFailure();
    expect(calls.heals).toBe(1);
    schedule.advance(DELAYS[1]!);
    controller.attemptMounted();

    // Stability refills the budget and ends the cycle.
    controller.handleConnected();
    schedule.advance(STREAM_RECONNECT_STABILITY_MS);

    // Cycle 2 heals once more.
    controller.handleDisconnected();
    expect(calls.heals).toBe(2);

    // Exhaust cycle 2 without further heals, then wake heals again.
    for (let i = 1; i < STREAM_RECONNECT_MAX_ATTEMPTS + 1; i++) {
      schedule.advance(DELAYS[Math.min(i, DELAYS.length - 1)]!);
      controller.attemptMounted();
      controller.handleFailure();
    }
    expect(controller.getSnapshot().status).toBe('unavailable');
    expect(calls.heals).toBe(2);
    controller.handleWake();
    expect(calls.heals).toBe(3);

    // The restarted attempt fails: the wake's heal already covered this
    // cycle — no second heal (the attempt===1 derivation used to fire one).
    controller.attemptMounted();
    controller.handleFailure();
    expect(controller.getSnapshot()).toEqual({ status: 'reconnecting', attempt: 1 });
    expect(calls.heals).toBe(3);
  });
});

describe('onError reporting', () => {
  function withErrors() {
    const schedule = new FakeSchedule();
    const errors: { reason: string; message: string; attempt: number; final: boolean }[] = [];
    const controller = createStreamReconnectController({
      onRemount: () => controller.attemptMounted(),
      onHeal: () => {},
      onSnapshot: () => {},
      onError: (error) => {
        errors.push(error);
      },
      schedule,
      random: NO_JITTER,
    });
    controller.attemptMounted();
    return { schedule, controller, errors };
  }

  test('reports each failed attempt once with its reason and counter', () => {
    const { schedule, controller, errors } = withErrors();
    controller.handleFailure({ reason: 'credentials_unavailable', message: 'no key' });
    controller.handleFailure({ reason: 'connection_refused', message: 'ignored: same attempt' });
    expect(errors).toEqual([{ reason: 'credentials_unavailable', message: 'no key', attempt: 1, final: false }]);
    schedule.advance(DELAYS[0]);
    controller.handleFailure({ reason: 'connection_refused', message: 'closed' });
    expect(errors.map((e) => [e.reason, e.attempt, e.final])).toEqual([
      ['credentials_unavailable', 1, false],
      ['connection_refused', 2, false],
    ]);
  });

  test('marks the last failure final once retries stop, and not before', () => {
    const { schedule, controller, errors } = withErrors();
    for (let i = 0; i <= STREAM_RECONNECT_MAX_ATTEMPTS; i++) {
      controller.handleFailure({ reason: 'connection_refused', message: 'closed' });
      schedule.advance(30_000);
    }
    expect(errors).toHaveLength(STREAM_RECONNECT_MAX_ATTEMPTS + 1);
    expect(errors.filter((e) => e.final)).toHaveLength(1);
    expect(errors.at(-1)).toMatchObject({ final: true, attempt: STREAM_RECONNECT_MAX_ATTEMPTS + 1 });
    expect(controller.getSnapshot().status).toBe('unavailable');
  });

  test('a dropped session is disconnected and a silent attempt is unknown', () => {
    const { schedule, controller, errors } = withErrors();
    controller.handleConnected();
    controller.handleDisconnected();
    schedule.advance(DELAYS[0]);
    schedule.advance(STREAM_CONNECT_TIMEOUT_MS);
    expect(errors.map((e) => e.reason)).toEqual(['disconnected', 'unknown']);
  });

  test('a failure without detail is unknown', () => {
    const { controller, errors } = withErrors();
    controller.handleFailure();
    expect(errors.map((e) => e.reason)).toEqual(['unknown']);
  });

  test('a throwing consumer callback does not stop the retry', () => {
    const schedule = new FakeSchedule();
    let remounts = 0;
    const controller = createStreamReconnectController({
      onRemount: () => { remounts += 1; },
      onHeal: () => {},
      onSnapshot: () => {},
      onError: () => { throw new Error('consumer bug'); },
      schedule,
      random: NO_JITTER,
    });
    controller.attemptMounted();
    controller.handleFailure();
    schedule.advance(DELAYS[0]);
    expect(remounts).toBe(1);
  });
});

describe('attempt counting', () => {
  test('the reconnect pill number and onError attempt are the same count at every failure', () => {
    const schedule = new FakeSchedule();
    const snapshots: StreamReconnectSnapshot[] = [];
    const errors: { attempt: number; final: boolean }[] = [];
    const controller = createStreamReconnectController({
      onRemount: () => controller.attemptMounted(),
      onHeal: () => {},
      onSnapshot: (s) => snapshots.push(s),
      onError: (e) => { errors.push(e); },
      schedule,
      random: NO_JITTER,
    });
    controller.attemptMounted();
    const pills: string[] = [];
    for (let failure = 1; failure <= STREAM_RECONNECT_MAX_ATTEMPTS + 1; failure++) {
      controller.handleFailure({ reason: 'connection_refused', message: 'closed' });
      const { status, attempt } = controller.getSnapshot();
      expect(errors.at(-1)!.attempt).toBe(attempt);
      if (status === 'reconnecting') pills.push(reconnectPillLabel('reconnecting', attempt, STREAM_RECONNECT_MAX_ATTEMPTS));
      schedule.advance(30_000);
    }
    expect(pills).toEqual([1, 2, 3, 4, 5, 6].map((n) => `reconnecting (${n}/6)`));
    expect(errors.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(errors.map((e) => e.final)).toEqual([false, false, false, false, false, false, true]);
    expect(controller.getSnapshot().status).toBe('unavailable');
  });

  test('the pill label has no suffix before the first failure', () => {
    expect(reconnectPillLabel('reconnecting', 0, 6)).toBe('reconnecting');
    expect(reconnectPillLabel('Getrennt', 2, 6)).toBe('Getrennt (2/6)');
  });
});
