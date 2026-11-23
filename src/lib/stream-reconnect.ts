// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import type { StreamError, StreamFailure } from './stream-error';

/**
 * Pure reconnect state machine for a single device stream. Framework-free so
 * the timing/backoff logic is unit-testable; `use-stream-reconnect` wires it
 * into React (remounts via key bump, snapshot into state).
 *
 * Lifecycle contract with the hook:
 *  - `attemptMounted(false)` prepares a provider phase without a watchdog;
 *    `attemptMounted()` starts the watchdog when its socket allocates.
 *    The default keeps existing mount-driven callers unchanged.
 *  - `onRemount()` asks the hook to bump the mount epoch and prepare the next
 *    attempt; its socket allocation then starts the connect watchdog.
 *  - `handleConnected`/`handleDisconnected` mirror the WebRTC connection
 *    state; `handleFailure` is the terminal-failure signal (WS died, peer
 *    connection failed, negotiation threw).
 *
 * Reconnect policy:
 *  - A failed attempt schedules the next one with exponential backoff
 *    (1s → 30s, ±25% jitter). After MAX_ATTEMPTS consecutive failures the
 *    stream is declared unavailable and retries stop.
 *  - Holding a connection for STABILITY_MS refills the retry budget, so the
 *    known server-side ~2min disconnect loop (DRO-2705) keeps reconnecting
 *    quickly forever instead of escalating into `unavailable`.
 *  - `handleWake` (tab visible) short-circuits a pending
 *    backoff wait, and starts a fresh retry cycle when unavailable.
 */

export type StreamReconnectStatus = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export interface StreamReconnectSnapshot {
  status: StreamReconnectStatus;
  /**
   * Consecutive failed attempts so far — the 1-based number of the upcoming
   * (or in-flight) reconnect attempt. 0 while connecting fresh or after the
   * stability window refilled the budget.
   */
  attempt: number;
}

export const STREAM_RECONNECT_MAX_ATTEMPTS = 6;
// Key acquisition precedes socket allocation and has its own independent budget.
export const STREAM_TOKEN_PROVIDER_TIMEOUT_MS = 10_000;
// Connection-layer phase budgets, enforced in use-webrtc-connection: how long
// the signaling WebSocket may take to open, and how long the RTCConfiguration
// reply may take after that. Each phase rejects (→ onConnectionFailed) when
// its budget runs out, so a dead attempt is counted the moment the layer that
// owns it gives up. Defined here, next to the watchdog, because the three
// values form one contract — see STREAM_CONNECT_TIMEOUT_MS.
export const STREAM_WS_OPEN_TIMEOUT_MS = 15_000;
export const STREAM_RTC_CONFIG_TIMEOUT_MS = 15_000;
// Watchdog for a whole connect attempt. Its real job is the one phase with no
// self-timeout — waiting for the SDP answer / ICE to land after the offer is
// sent — so it MUST exceed the sum of the self-timed phases above (plus a
// negotiation allowance) or it would preempt slow-but-valid handshakes the
// connection layer still considers on budget, and on the final retry strand
// the stream in 'unavailable' mid-handshake. Guarded by a test.
export const STREAM_CONNECT_TIMEOUT_MS = 45_000;
export const STREAM_RECONNECT_STABILITY_MS = 30_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export function streamReconnectDelayMs(attempt: number, random: () => number = Math.random) {
  const base = Math.min(BASE_DELAY_MS * 2 ** (Math.max(1, attempt) - 1), MAX_DELAY_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}

type TimerId = ReturnType<typeof setTimeout>;

export interface StreamReconnectSchedule {
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export interface StreamReconnectControllerOptions {
  /** Bump the mount epoch — remounts the stream component. */
  onRemount(allowOffline?: boolean): void;
  /** Status/attempt changed. */
  onSnapshot(snapshot: StreamReconnectSnapshot): void;
  /** A reconnect attempt is being scheduled — refetch stream credentials. */
  onHeal(): void;
  /** One call per counted failure, with the reason and whether retries stopped. */
  onError?(error: StreamError): void;
  schedule?: StreamReconnectSchedule;
  random?: () => number;
  /** Unknown connectivity is optimistic; false pauses acquisition and retry timing. */
  networkAvailable?: boolean;
}

export interface StreamReconnectController {
  /** Begin an attempt; defer the watchdog until socket allocation when false. */
  attemptMounted(startWatchdog?: boolean, allowOffline?: boolean): void;
  /** No stream target anymore (URL gone) — stop timers, reset counters. */
  setDisabled(): void;
  handleConnected(): void;
  handleDisconnected(): void;
  /** Terminal failure of the current attempt; `failure` names why (default `unknown`). */
  handleFailure(failure?: StreamFailure): void;
  /**
   * Whether a stream-target change (URL/token rotation) must be held back
   * instead of applied right now. True while waiting out a backoff (an
   * immediate switch would bypass the wait — the scheduled attempt picks the
   * fresh target up by itself) and while unavailable (retry/wake own recovery
   * there). Everywhere else — connected, connecting, a retry in flight, or
   * disabled — the new target applies immediately.
   */
  shouldDeferTargetChange(): boolean;
  /** Observe connectivity; initial commit only seeds a still-fresh connecting attempt. */
  setNetworkAvailable(available: boolean, initialCommit?: boolean): void;
  /** Tab became visible. */
  handleWake(): void;
  /** Manual retry; explicitly overrides advisory offline for one fresh attempt. */
  retry(): void;
  dispose(): void;
  getSnapshot(): StreamReconnectSnapshot;
}

export function createStreamReconnectController({
  onRemount,
  onSnapshot,
  onHeal,
  onError,
  schedule = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  random = Math.random,
  networkAvailable = true,
}: StreamReconnectControllerOptions): StreamReconnectController {
  let enabled = false;
  let disposed = false;
  let forcedAttempt = false;
  let status: StreamReconnectStatus = 'connecting';
  let attempt = 0;
  // Whether the current mount epoch ever reached 'connected'. Gates
  // handleDisconnected: the peer connection reports non-connected states
  // (e.g. 'connecting') during normal negotiation, which must not count as
  // failures — the watchdog and handleFailure cover a negotiation that never
  // lands.
  let everConnectedThisEpoch = false;
  // One failure per mount epoch: a dying attempt typically fires several
  // signals (WS close + pc 'failed' + state change) that must collapse into
  // a single backoff step.
  let failureLatched = false;
  // One heal per recovery cycle. Tracked explicitly rather than derived from
  // the attempt counter: freshCycle() heals with attempt reset to 0, so its
  // first failed retry would otherwise heal again at attempt === 1.
  let healedThisCycle = false;
  let watchdogTimer: TimerId | null = null;
  let backoffTimer: TimerId | null = null;
  let stabilityTimer: TimerId | null = null;

  const emit = () => onSnapshot({ status, attempt });

  const clearTimer = (id: TimerId | null): null => {
    if (id !== null) schedule.clearTimeout(id);
    return null;
  };

  const clearAllTimers = () => {
    watchdogTimer = clearTimer(watchdogTimer);
    backoffTimer = clearTimer(backoffTimer);
    stabilityTimer = clearTimer(stabilityTimer);
  };

  const reportError = (failure: StreamFailure, final: boolean) => {
    // A consumer callback must never break the reconnect machine.
    try {
      onError?.({ reason: failure.reason, message: failure.message, attempt, final });
    } catch {
      // Ignored on purpose.
    }
  };

  const startAttempt = (allowOffline = false) => {
    if (!enabled || (!networkAvailable && !allowOffline) || disposed) return;
    onRemount(allowOffline);
    // The resulting mount calls attemptMounted(), which arms the watchdog.
  };

  const countFailure = (failure: StreamFailure) => {
    // A wait is already scheduled (or we already gave up) — e.g. a stale
    // watchdog armed by a StrictMode double-mount. Never stack timers.
    if (backoffTimer !== null || status === 'unavailable') return;
    if (!networkAvailable && !everConnectedThisEpoch && !forcedAttempt) return;
    forcedAttempt = false;
    failureLatched = true;
    watchdogTimer = clearTimer(watchdogTimer);
    stabilityTimer = clearTimer(stabilityTimer);
    attempt += 1;
    if (attempt > STREAM_RECONNECT_MAX_ATTEMPTS) {
      status = 'unavailable';
      emit();
      reportError(failure, true);
      return;
    }
    status = 'reconnecting';
    emit();
    reportError(failure, false);
    // Refetch credentials once per recovery cycle, not per attempt: consumer
    // onHeal callbacks trigger network refetches (grids share one full-fleet
    // refetch across every card), so per-attempt heals would multiply into a
    // request storm during exactly the shared outage being recovered from.
    // Credentials fetched at cycle start stay fresh across the cycle's ~2min
    // span, and a refresh that resolves after a retry started still applies
    // via shouldDeferTargetChange/onRemount.
    if (!networkAvailable) return;
    if (!healedThisCycle) {
      healedThisCycle = true;
      onHeal();
    }
    backoffTimer = schedule.setTimeout(
      () => {
        backoffTimer = null;
        startAttempt();
      },
      streamReconnectDelayMs(attempt, random),
    );
  };

  const freshCycle = (allowOffline = false) => {
    forcedAttempt = allowOffline;
    attempt = 0;
    failureLatched = false;
    everConnectedThisEpoch = false;
    // This heal covers the whole restarted cycle — a failure of the
    // restarted attempt must not heal a second time.
    healedThisCycle = true;
    status = 'reconnecting';
    emit();
    onHeal();
    startAttempt(allowOffline);
  };

  return {
    attemptMounted(startWatchdog = true, allowOffline = false) {
      forcedAttempt = allowOffline;
      enabled = true;
      disposed = false;
      // Mid-wait mounts are stale (StrictMode remount): the scheduled
      // attempt owns the next watchdog.
      if (backoffTimer !== null || status === 'unavailable') return;
      watchdogTimer = clearTimer(watchdogTimer);
      everConnectedThisEpoch = false;
      failureLatched = false;
      if (status === 'connected') {
        // Remount tossed the live connection (credential rotation) — the new
        // one is negotiating.
        stabilityTimer = clearTimer(stabilityTimer);
        status = 'connecting';
        emit();
      }
      if ((!networkAvailable && !forcedAttempt) || !startWatchdog) return;
      watchdogTimer = schedule.setTimeout(() => {
        watchdogTimer = null;
        countFailure({ reason: 'unknown', message: 'Connection attempt timed out' });
      }, STREAM_CONNECT_TIMEOUT_MS);
    },

    setDisabled() {
      forcedAttempt = false;
      enabled = false;
      disposed = false;
      clearAllTimers();
      everConnectedThisEpoch = false;
      failureLatched = false;
      healedThisCycle = false;
      if (status !== 'connecting' || attempt !== 0) {
        status = 'connecting';
        attempt = 0;
        emit();
      }
    },

    handleConnected() {
      if (!enabled) return;
      watchdogTimer = clearTimer(watchdogTimer);
      // The old attempt recovered on its own (transient ICE dip) — the
      // scheduled remount would only interrupt it again.
      backoffTimer = clearTimer(backoffTimer);
      everConnectedThisEpoch = true;
      failureLatched = false;
      if (status !== 'connected') {
        status = 'connected';
        emit();
      }
      stabilityTimer = clearTimer(stabilityTimer);
      stabilityTimer = schedule.setTimeout(() => {
        stabilityTimer = null;
        // The cycle is over — the next failure run heals anew.
        healedThisCycle = false;
        if (attempt !== 0) {
          attempt = 0;
          emit();
        }
      }, STREAM_RECONNECT_STABILITY_MS);
    },

    handleDisconnected() {
      if (!enabled) return;
      if (!everConnectedThisEpoch) return;
      if (failureLatched) return;
      countFailure({ reason: 'disconnected', message: 'The stream connection dropped' });
    },

    handleFailure(failure = { reason: 'unknown', message: 'Connection failed' }) {
      if (!enabled) return;
      if (failureLatched) return;
      countFailure(failure);
    },

    shouldDeferTargetChange() {
      // onHeal-triggered credential refetches routinely resolve after the
      // retry has started; outside the two deferred states the change must
      // apply immediately or an in-flight attempt would run on stale
      // credentials until the connect watchdog fails it.
      return backoffTimer !== null || status === 'unavailable';
    },

    setNetworkAvailable(available, initialCommit = false) {
      if (disposed || available === networkAvailable) return;
      networkAvailable = available;
      watchdogTimer = clearTimer(watchdogTimer);
      backoffTimer = clearTimer(backoffTimer);
      if (!available) return;
      if (status === 'connected') return;
      if (initialCommit && status === 'connecting' && attempt === 0) return;
      if (enabled) freshCycle();
      else onHeal(); // No target yet: its existing owner resumes discovery.
    },

    handleWake() {
      if (!enabled || !networkAvailable) return;
      if (status === 'unavailable') {
        freshCycle();
        return;
      }
      if (backoffTimer !== null) {
        // Don't sit out a (possibly throttled) background wait now that the
        // user is looking.
        backoffTimer = clearTimer(backoffTimer);
        startAttempt();
      }
    },

    retry() {
      if (!enabled) return;
      if (!networkAvailable || status === 'unavailable') {
        clearAllTimers();
        freshCycle(!networkAvailable);
      }
    },

    dispose() {
      forcedAttempt = false;
      disposed = true;
      enabled = false;
      clearAllTimers();
    },

    getSnapshot() {
      return { status, attempt };
    },
  };
}
