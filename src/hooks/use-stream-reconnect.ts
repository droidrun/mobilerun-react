'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamReconnectController, type StreamReconnectSnapshot } from '../lib/stream-reconnect';

interface UseStreamReconnectOptions<T> {
  /**
   * Fired when a reconnect cycle starts (first failure) and on wake/manual
   * retry — refetch fresh stream credentials in case the URL/token went
   * stale. Deliberately not fired per attempt: consumers refetch over the
   * network, and grids share one fleet-wide refetch across every card.
   */
  onHeal?: () => void;
  /**
   * The connection target (URL/credentials) the consumer currently wants.
   * The hook pins the target the stream actually uses: `activeTarget` only
   * advances together with a remount, so a change arriving during a backoff
   * wait or while unavailable is held back until the next scheduled/manual
   * attempt instead of restarting the connection mid-wait (which would
   * bypass the backoff — every heal refetches credentials, so a rotating
   * token would otherwise zero the wait each cycle). In every other state
   * the change applies immediately via a remount.
   */
  target: T;
  /** Stable identity of `target` — when it changes, the target changed. */
  targetKey: string;
  /** False while there is no stream target (no URL yet) — pauses all timers. */
  enabled: boolean;
}

/**
 * Reconnect manager for a single WebRTC device stream. Owns when the stream
 * component (re)mounts (`streamKey` as React `key`) and which target it
 * connects to (`activeTarget` — render the stream from this, not from raw
 * props), retries failed connections with exponential backoff, gives up into
 * `unavailable` after the retry budget is spent, and starts a fresh cycle
 * when the tab becomes visible / the browser comes back online / `retry()`
 * is called.
 *
 * Forward `onConnectionStateChange` and `onConnectionFailed` to the stream
 * component; render status/attempt as the user-facing connection state.
 */
export function useStreamReconnect<T>({
  onHeal,
  target,
  targetKey,
  enabled,
}: UseStreamReconnectOptions<T>) {
  const [snapshot, setSnapshot] = useState<StreamReconnectSnapshot>({
    status: 'connecting',
    attempt: 0,
  });
  // The mount epoch and the target that mount uses advance atomically, so a
  // remounted stream never renders one commit on a stale target.
  const [mount, setMount] = useState<{ epoch: number; target: T }>(() => ({ epoch: 0, target }));
  // Key of the last APPLIED target — the comparison base for detecting
  // pending target changes. Deliberately not advanced when a change is
  // deferred; see the render-phase check below.
  const [lastTargetKey, setLastTargetKey] = useState(targetKey);

  const onHealRef = useRef(onHeal);
  onHealRef.current = onHeal;

  // Latest committed target (and its key), for timer-driven remounts
  // (backoff fire, wake, retry). Written in an effect so a render React
  // abandons never leaks its value into a later attempt.
  const targetRef = useRef(target);
  const targetKeyRef = useRef(targetKey);
  useEffect(() => {
    targetRef.current = target;
    targetKeyRef.current = targetKey;
  });

  // Applying a target always records its key too, so a change that was
  // pending while deferred is not re-applied a second time afterwards.
  const bumpMount = useCallback(() => {
    setLastTargetKey(targetKeyRef.current);
    setMount((m) => ({ epoch: m.epoch + 1, target: targetRef.current }));
  }, []);

  // Lazy-initialized once; stable for the component's lifetime, so effects
  // and callbacks below can read it with empty deps.
  const controllerRef = useRef<ReturnType<typeof createStreamReconnectController> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createStreamReconnectController({
      onRemount: bumpMount,
      onSnapshot: (s) => setSnapshot(s),
      onHeal: () => onHealRef.current?.(),
    });
  }

  // Target changes apply by remounting with the new target in the same
  // commit — unless the controller defers them (backoff wait, unavailable).
  // A deferred change stays PENDING (the key is only consumed when a target
  // is applied): either the scheduled/manual attempt picks the latest target
  // up via bumpMount, or — when the old connection self-recovers and cancels
  // that attempt — the pending change is re-detected on the recovery render
  // and applied here, instead of stranding the pin on the old target.
  // React's "adjust state during render" pattern, with the comparison base
  // in state (not a ref, declared above): a render React abandons discards
  // the comparison and the bump together, so the change is re-detected on
  // the next committed render instead of being consumed and lost.
  if (lastTargetKey !== targetKey && !controllerRef.current.shouldDeferTargetChange()) {
    setLastTargetKey(targetKey);
    setMount((m) => ({ epoch: m.epoch + 1, target }));
  }

  // Every mount/remount of the stream component (or enable flip) re-arms the
  // connect watchdog. Runs after render, i.e. after the remounted component
  // actually exists.
  useEffect(() => {
    if (enabled) {
      controllerRef.current?.attemptMounted();
    } else {
      controllerRef.current?.setDisabled();
    }
  }, [mount.epoch, enabled]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') controllerRef.current?.handleWake();
    };
    const onOnline = () => controllerRef.current?.handleWake();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    return () => controllerRef.current?.dispose();
  }, []);

  const onConnectionStateChange = useCallback((connected: boolean) => {
    if (connected) controllerRef.current?.handleConnected();
    else controllerRef.current?.handleDisconnected();
  }, []);

  const onConnectionFailed = useCallback(() => controllerRef.current?.handleFailure(), []);

  const retry = useCallback(() => controllerRef.current?.retry(), []);

  return {
    streamKey: String(mount.epoch),
    /** The pinned target to render the stream from — NOT the raw props. */
    activeTarget: mount.target,
    status: snapshot.status,
    attempt: snapshot.attempt,
    onConnectionStateChange,
    onConnectionFailed,
    retry,
  };
}
