// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure reconnect state machine for a single device stream. Framework-free so
 * the timing/backoff logic is unit-testable; `use-stream-reconnect` wires it
 * into React (remounts via key bump, snapshot into state).
 *
 * Lifecycle contract with the hook:
 *  - `attemptMounted()` is called after every mount/remount of the underlying
 *    stream component (and on enable). It arms the connect watchdog.
 *  - `onRemount()` asks the hook to bump the mount epoch; the resulting mount
 *    calls `attemptMounted()` back.
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
 *  - `handleWake` (tab visible / back online) short-circuits a pending
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
export const STREAM_CONNECT_TIMEOUT_MS = 20_000;
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
  onRemount(): void;
  /** Status/attempt changed. */
  onSnapshot(snapshot: StreamReconnectSnapshot): void;
  /** A reconnect attempt is being scheduled — refetch stream credentials. */
  onHeal(): void;
  schedule?: StreamReconnectSchedule;
  random?: () => number;
}

export interface StreamReconnectController {
  /** The stream component (re)mounted; arm the connect watchdog. */
  attemptMounted(): void;
  /** No stream target anymore (URL gone) — stop timers, reset counters. */
  setDisabled(): void;
  handleConnected(): void;
  handleDisconnected(): void;
  handleFailure(): void;
  /**
   * Whether a stream-target change (URL/token rotation) must be held back
   * instead of applied right now. True while waiting out a backoff (an
   * immediate switch would bypass the wait — the scheduled attempt picks the
   * fresh target up by itself) and while unavailable (retry/wake own recovery
   * there). Everywhere else — connected, connecting, a retry in flight, or
   * disabled — the new target applies immediately.
   */
  shouldDeferTargetChange(): boolean;
  /** Tab became visible / browser back online. */
  handleWake(): void;
  /** Manual retry (Unavailable-state button). */
  retry(): void;
  dispose(): void;
  getSnapshot(): StreamReconnectSnapshot;
}

export function createStreamReconnectController({
  onRemount,
  onSnapshot,
  onHeal,
  schedule = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  random = Math.random,
}: StreamReconnectControllerOptions): StreamReconnectController {
  let enabled = false;
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

  const startAttempt = () => {
    onRemount();
    // The resulting mount calls attemptMounted(), which arms the watchdog.
  };

  const countFailure = () => {
    // A wait is already scheduled (or we already gave up) — e.g. a stale
    // watchdog armed by a StrictMode double-mount. Never stack timers.
    if (backoffTimer !== null || status === 'unavailable') return;
    failureLatched = true;
    watchdogTimer = clearTimer(watchdogTimer);
    stabilityTimer = clearTimer(stabilityTimer);
    attempt += 1;
    if (attempt > STREAM_RECONNECT_MAX_ATTEMPTS) {
      status = 'unavailable';
      emit();
      return;
    }
    status = 'reconnecting';
    emit();
    // Refetch credentials once per recovery cycle, not per attempt: consumer
    // onHeal callbacks trigger network refetches (grids share one full-fleet
    // refetch across every card), so per-attempt heals would multiply into a
    // request storm during exactly the shared outage being recovered from.
    // Credentials fetched at cycle start stay fresh across the cycle's ~2min
    // span, and a refresh that resolves after a retry started still applies
    // via shouldDeferTargetChange/onRemount.
    if (attempt === 1) onHeal();
    backoffTimer = schedule.setTimeout(
      () => {
        backoffTimer = null;
        startAttempt();
      },
      streamReconnectDelayMs(attempt, random),
    );
  };

  const freshCycle = () => {
    attempt = 0;
    failureLatched = false;
    everConnectedThisEpoch = false;
    status = 'reconnecting';
    emit();
    onHeal();
    startAttempt();
  };

  return {
    attemptMounted() {
      enabled = true;
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
      watchdogTimer = schedule.setTimeout(() => {
        watchdogTimer = null;
        countFailure();
      }, STREAM_CONNECT_TIMEOUT_MS);
    },

    setDisabled() {
      enabled = false;
      clearAllTimers();
      everConnectedThisEpoch = false;
      failureLatched = false;
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
      countFailure();
    },

    handleFailure() {
      if (!enabled) return;
      if (failureLatched) return;
      countFailure();
    },

    shouldDeferTargetChange() {
      // onHeal-triggered credential refetches routinely resolve after the
      // retry has started; outside the two deferred states the change must
      // apply immediately or an in-flight attempt would run on stale
      // credentials until the connect watchdog fails it.
      return backoffTimer !== null || status === 'unavailable';
    },

    handleWake() {
      if (!enabled) return;
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
      if (status === 'unavailable') freshCycle();
    },

    dispose() {
      enabled = false;
      clearAllTimers();
    },

    getSnapshot() {
      return { status, attempt };
    },
  };
}
