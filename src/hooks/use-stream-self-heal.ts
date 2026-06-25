// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';

const STABILITY_MS = 30_000;

type StabilityTracker = {
  handle: (connected: boolean) => void;
  reset: () => void;
  dispose: () => void;
};

// Detects "meaningful" disconnects: a drop only counts after the connection has
// been stable for STABILITY_MS, so transient negotiation/jitter doesn't trigger
// a heal.
function createStabilityTracker(onMeaningfulDisconnect: () => void): StabilityTracker {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wasStable = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    handle(connected) {
      if (connected) {
        clearTimer();
        wasStable = false;
        timer = setTimeout(() => {
          wasStable = true;
          timer = null;
        }, STABILITY_MS);
      } else {
        clearTimer();
        if (wasStable) {
          wasStable = false;
          onMeaningfulDisconnect();
        }
      }
    },
    reset() {
      clearTimer();
      wasStable = false;
    },
    dispose() {
      clearTimer();
      wasStable = false;
    },
  };
}

interface UseStreamSelfHealOptions {
  onHeal?: () => void;
  /**
   * Identifier of the underlying connection target — typically a composite of
   * stream URL + credentials. Two roles:
   *  1. When it changes, the stability tracker resets, so the next `connecting`
   *     callback from a fresh peer isn't misread as a stable disconnect.
   *  2. It is folded into the returned `streamKey` so any change forces the
   *     consumer to remount its WebRTC component (covers credential rotation
   *     where the underlying RemoteControl wouldn't otherwise restart).
   */
  restartKey?: string;
}

/**
 * Self-heals a single WebRTC stream: when a stably-connected stream drops,
 * bumps an epoch (used as a `key` to remount the underlying connection) and
 * fires `onHeal` so the caller can refetch fresh stream credentials. Slap the
 * returned `streamKey` onto the WebRTC component as `key={streamKey}` and
 * forward `onConnectionStateChange`.
 */
export function useStreamSelfHeal({ onHeal, restartKey }: UseStreamSelfHealOptions = {}) {
  const [epoch, setEpoch] = useState(0);
  const onHealRef = useRef(onHeal);
  onHealRef.current = onHeal;

  const trackerRef = useRef<StabilityTracker | null>(null);
  if (trackerRef.current === null) {
    trackerRef.current = createStabilityTracker(() => {
      setEpoch((e) => e + 1);
      onHealRef.current?.();
    });
  }

  // Reset synchronously during render, so the reset is applied before the new
  // RemoteControl's effects subscribe to `connectionstatechange` on the fresh
  // peer.
  const lastRestartKeyRef = useRef(restartKey);
  if (lastRestartKeyRef.current !== restartKey) {
    lastRestartKeyRef.current = restartKey;
    trackerRef.current.reset();
  }

  const onConnectionStateChange = useCallback((connected: boolean) => {
    trackerRef.current?.handle(connected);
  }, []);

  useEffect(() => {
    return () => trackerRef.current?.dispose();
  }, []);

  const streamKey = `${epoch}|${restartKey ?? ''}`;

  return { onConnectionStateChange, streamKey };
}

/**
 * Multi-device variant: tracks self-heal state per deviceId. Used by grid-like
 * views that show many streams and want a single shared `onHeal` (e.g. to
 * refetch the device list).
 */
export function useDeviceGridSelfHeal({ onHeal }: { onHeal?: () => void }) {
  const trackersRef = useRef<Map<string, StabilityTracker>>(new Map());
  const [deviceEpochs, setDeviceEpochs] = useState<Map<string, number>>(new Map());
  const onHealRef = useRef(onHeal);
  onHealRef.current = onHeal;

  const getTracker = useCallback((deviceId: string) => {
    let t = trackersRef.current.get(deviceId);
    if (!t) {
      t = createStabilityTracker(() => {
        setDeviceEpochs((prev) => {
          const next = new Map(prev);
          next.set(deviceId, (next.get(deviceId) ?? 0) + 1);
          return next;
        });
        onHealRef.current?.();
      });
      trackersRef.current.set(deviceId, t);
    }
    return t;
  }, []);

  const createConnectionHandler = useCallback(
    (deviceId: string) => (connected: boolean) => getTracker(deviceId).handle(connected),
    [getTracker],
  );

  const getDeviceEpoch = useCallback(
    (deviceId: string) => deviceEpochs.get(deviceId) ?? 0,
    [deviceEpochs],
  );

  useEffect(() => {
    const trackers = trackersRef.current;
    return () => {
      for (const t of trackers.values()) t.dispose();
      trackers.clear();
    };
  }, []);

  return { createConnectionHandler, getDeviceEpoch };
}
