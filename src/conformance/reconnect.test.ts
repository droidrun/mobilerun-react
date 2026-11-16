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
} from '../lib/stream-reconnect';
import { FakeSchedule } from '../lib/test-clock';
import { expectAllFixturesUsed, loadFixture } from './fixtures';

expectAllFixturesUsed('reconnect', ['policy', 'scenarios']);

const policy = loadFixture('reconnect/policy.json');
const { scenarios } = loadFixture<{ scenarios: Scenario[] }>('reconnect/scenarios.json');
const timing = loadFixture('signalling/sequence.json').timing;

interface Scenario {
  name: string;
  random: number;
  steps: { at_ms: number; event: string }[];
  expect: {
    at_ms: number;
    after_steps: number;
    status: string;
    attempt: number;
    heal_calls: number;
    remount_calls: number;
    defer_target_change?: boolean;
    pending_timers?: number;
  }[];
}

describe('reconnect/policy', () => {
  test('constants', () => {
    expect(STREAM_RECONNECT_MAX_ATTEMPTS).toBe(policy.max_attempts);
    expect(STREAM_CONNECT_TIMEOUT_MS).toBe(policy.connect_timeout_ms);
    expect(STREAM_RECONNECT_STABILITY_MS).toBe(policy.stability_ms);
    expect(STREAM_WS_OPEN_TIMEOUT_MS).toBe(timing.ws_open_timeout_ms);
    expect(STREAM_RTC_CONFIG_TIMEOUT_MS).toBe(timing.rtc_config_timeout_ms);
  });
  for (const c of policy.delay_cases as { attempt: number; random: number; delay_ms: number }[]) {
    test(`delay attempt ${c.attempt} random ${c.random}`, () => {
      expect(streamReconnectDelayMs(c.attempt, () => c.random)).toBe(c.delay_ms);
    });
  }
});

describe('reconnect/scenarios', () => {
  for (const s of scenarios) {
    test(s.name, () => {
      const clock = new FakeSchedule();
      const calls = { heal: 0, remount: 0 };
      const controller = createStreamReconnectController({
        onRemount: () => void (calls.remount += 1),
        onHeal: () => void (calls.heal += 1),
        onSnapshot: () => {},
        schedule: clock,
        random: () => s.random,
      });
      const apply: Record<string, () => void> = {
        attempt_mounted: () => controller.attemptMounted(),
        connected: () => controller.handleConnected(),
        disconnected: () => controller.handleDisconnected(),
        failure: () => controller.handleFailure(),
        wake: () => controller.handleWake(),
        retry: () => controller.retry(),
        disable: () => controller.setDisabled(),
        dispose: () => controller.dispose(),
      };
      const check = (i: number) => {
        for (const e of s.expect.filter((x) => x.after_steps === i).sort((a, b) => a.at_ms - b.at_ms)) {
          clock.advanceTo(e.at_ms);
          const label = `@${e.at_ms}ms after ${i} steps`;
          const snapshot = controller.getSnapshot();
          expect([label, snapshot.status]).toEqual([label, e.status]);
          expect([label, snapshot.attempt]).toEqual([label, e.attempt]);
          expect([label, calls.heal]).toEqual([label, e.heal_calls]);
          expect([label, calls.remount]).toEqual([label, e.remount_calls]);
          if (e.defer_target_change !== undefined) {
            expect([label, controller.shouldDeferTargetChange()]).toEqual([label, e.defer_target_change]);
          }
          if (e.pending_timers !== undefined) expect([label, clock.pendingCount]).toEqual([label, e.pending_timers]);
        }
      };
      check(0);
      s.steps.forEach((step, index) => {
        clock.advanceTo(step.at_ms);
        apply[step.event]();
        check(index + 1);
      });
    });
  }
});
