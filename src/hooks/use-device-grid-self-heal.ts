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

/**
 * Multi-device variant of stream healing: tracks self-heal state per deviceId.
 * Used by grid-like views that show many streams and want a single shared
 * `onHeal` (e.g. to refetch the device list).
 *
 * Note: single-stream consumers should use `useStreamReconnect` (built into
 * `DeviceStream`), which adds backoff, retry exhaustion, and wake-on-visible.
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
