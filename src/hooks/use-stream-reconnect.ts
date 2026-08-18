'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamReconnectController, type StreamReconnectSnapshot } from '../lib/stream-reconnect';

interface UseStreamReconnectOptions {
  /**
   * Fired whenever a reconnect attempt is scheduled or started — refetch
   * fresh stream credentials in case the URL/token went stale.
   */
  onHeal?: () => void;
  /**
   * Identifier of the underlying connection target — typically a composite of
   * stream URL + credentials. While connected/connecting, a change forces a
   * remount so the fresh credentials take effect (covers rotation where the
   * underlying RemoteControl wouldn't otherwise restart). During a backoff
   * wait or while unavailable it does NOT remount — the next attempt picks up
   * the fresh target on its own, and remounting early would bypass the
   * backoff (every heal refetches credentials, so a rotating token would
   * otherwise zero the wait each attempt).
   */
  restartKey?: string;
  /** False while there is no stream target (no URL yet) — pauses all timers. */
  enabled: boolean;
}

/**
 * Reconnect manager for a single WebRTC device stream. Owns when the stream
 * component (re)mounts (`streamKey` as React `key`), retries failed
 * connections with exponential backoff, gives up into `unavailable` after the
 * retry budget is spent, and starts a fresh cycle when the tab becomes
 * visible / the browser comes back online / `retry()` is called.
 *
 * Forward `onConnectionStateChange` and `onConnectionFailed` to the stream
 * component; render status/attempt as the user-facing connection state.
 */
export function useStreamReconnect({ onHeal, restartKey, enabled }: UseStreamReconnectOptions) {
  const [epoch, setEpoch] = useState(0);
  const [snapshot, setSnapshot] = useState<StreamReconnectSnapshot>({
    status: 'connecting',
    attempt: 0,
  });

  const onHealRef = useRef(onHeal);
  onHealRef.current = onHeal;

  // Lazy-initialized once; stable for the component's lifetime, so effects
  // and callbacks below can read it with empty deps.
  const controllerRef = useRef<ReturnType<typeof createStreamReconnectController> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createStreamReconnectController({
      onRemount: () => setEpoch((e) => e + 1),
      onSnapshot: (s) => setSnapshot(s),
      onHeal: () => onHealRef.current?.(),
    });
  }

  // Credential rotation: remount synchronously (render-phase state update, so
  // the new RemoteControl mounts with the fresh props in this same render) —
  // but only when the controller allows it; see `restartKey` docs above.
  const lastRestartKeyRef = useRef(restartKey);
  if (lastRestartKeyRef.current !== restartKey) {
    lastRestartKeyRef.current = restartKey;
    if (controllerRef.current.shouldRemountOnTargetChange()) {
      setEpoch((e) => e + 1);
    }
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
  }, [epoch, enabled]);

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
    streamKey: String(epoch),
    status: snapshot.status,
    attempt: snapshot.attempt,
    onConnectionStateChange,
    onConnectionFailed,
    retry,
  };
}
