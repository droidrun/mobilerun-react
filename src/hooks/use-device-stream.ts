'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Mobilerun } from '@mobilerun/sdk';

/**
 * The device object as returned by `@mobilerun/sdk`. Derived from the client so
 * this package stays in lock-step with whatever SDK version the consumer
 * installs (peer dependency) instead of pinning a copied type.
 */
type SdkDevice = Awaited<ReturnType<Mobilerun['devices']['retrieve']>>;

export interface UseDeviceStreamOptions {
  /** A configured `@mobilerun/sdk` client instance. */
  client: Mobilerun;
  /** The device to stream. */
  deviceId: string;
  /** Pause fetching when false (e.g. dialog closed). Defaults to true. */
  enabled?: boolean;
  /**
   * While the device has no `streamUrl` yet (still spinning up), re-fetch every
   * `pollIntervalMs`. Set to 0 to disable polling. Defaults to 3000ms.
   */
  pollIntervalMs?: number;
  /** Called when a fetch fails. */
  onError?: (error: unknown) => void;
}

export interface UseDeviceStreamResult {
  /** WebRTC signaling URL — feed straight into `<DeviceStream streamUrl />`. */
  streamUrl?: string;
  /** Stream auth token — feed into `<DeviceStream streamToken />`. */
  streamToken?: string;
  /** The device's lifecycle state (`ready`, `assigned`, ...). */
  state?: string;
  /** The full device object from the SDK, if loaded. */
  device?: SdkDevice;
  /** True until the first fetch resolves. */
  isLoading: boolean;
  /** The last fetch error, if any. */
  error?: unknown;
  /**
   * Re-fetch fresh stream credentials. Wire this into
   * `<DeviceStream onStreamHealed={refetch} />` so a self-heal pulls a fresh URL.
   */
  refetch: () => void;
}

/**
 * Resolves live WebRTC stream credentials for a device via `@mobilerun/sdk`,
 * polling while the device is still coming up. Pair with `<DeviceStream />`:
 *
 * ```tsx
 * const { streamUrl, streamToken, state, refetch } = useDeviceStream({ client, deviceId });
 * return (
 *   <DeviceStream
 *     streamUrl={streamUrl}
 *     streamToken={streamToken}
 *     hasControl
 *     placeholderLabel={state}
 *     onStreamHealed={refetch}
 *   />
 * );
 * ```
 */
export function useDeviceStream({
  client,
  deviceId,
  enabled = true,
  pollIntervalMs = 3000,
  onError,
}: UseDeviceStreamOptions): UseDeviceStreamResult {
  const [device, setDevice] = useState<SdkDevice | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<unknown>(undefined);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Bumping this triggers a re-fetch without changing the polling cadence.
  const [fetchEpoch, setFetchEpoch] = useState(0);
  const refetch = useCallback(() => setFetchEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!enabled || !deviceId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const next = await client.devices.retrieve(deviceId);
        if (cancelled) return;
        setDevice(next);
        setError(undefined);
        // Keep polling until the backend hands us a stream URL.
        if (!next.streamUrl && pollIntervalMs > 0) {
          pollTimer = setTimeout(load, pollIntervalMs);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err);
        onErrorRef.current?.(err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    setIsLoading(true);
    void load();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [client, deviceId, enabled, pollIntervalMs, fetchEpoch]);

  return {
    streamUrl: device?.streamUrl || undefined,
    streamToken: device?.streamToken || undefined,
    state: device?.state,
    device,
    isLoading,
    error,
    refetch,
  };
}
