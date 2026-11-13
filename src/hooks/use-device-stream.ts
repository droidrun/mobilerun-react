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

/**
 * The part of an `@mobilerun/sdk` device object (`sdk.devices.get(id)`) this hook
 * needs. Structural on purpose, so it also works with SDK versions that predate
 * the object API.
 */
export interface SdkDeviceHandle {
  id: string;
  /** Identifies the client behind the handle; with `id` it keys the effect so a fresh handle per render does not refetch. */
  api?: unknown;
  /** Re-fetches the device and resolves with its current info. */
  refresh(): PromiseLike<SdkDevice>;
}

interface UseDeviceStreamBase {
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

/** Pass either a configured `Mobilerun` client plus `deviceId`, or an SDK device object. */
export type UseDeviceStreamOptions = UseDeviceStreamBase &
  (
    | {
        /** A configured `@mobilerun/sdk` client instance. */
        client: Mobilerun;
        /** The device to stream. */
        deviceId: string;
        device?: undefined;
      }
    | {
        /** A device object from `sdk.devices.get(id)` (`@mobilerun/sdk` 6.2+). */
        device: SdkDeviceHandle;
        client?: undefined;
        deviceId?: undefined;
      }
  );

/** Fetches the device's current info from whichever source the caller passed. */
export function fetchDeviceInfo(source: {
  client?: Mobilerun;
  deviceId?: string;
  device?: SdkDeviceHandle;
}): PromiseLike<SdkDevice> {
  if (source.device) return source.device.refresh();
  return source.client!.devices.retrieve(source.deviceId!);
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
   * `<DeviceStream onStreamHealed={refetch} />` so a reconnect pulls a fresh URL.
   */
  refetch: () => void;
}

/**
 * Resolves live WebRTC stream credentials for a device via `@mobilerun/sdk`,
 * polling while the device is still coming up. Pair with `<DeviceStream />`:
 *
 * ```tsx
 * const { streamUrl, streamToken, state, refetch } = useDeviceStream({ device });
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
 *
 * `device` comes from `sdk.devices.get(id)`. An existing `{ client, deviceId }`
 * call keeps working.
 */
export function useDeviceStream({
  client,
  deviceId,
  device: deviceHandle,
  enabled = true,
  pollIntervalMs = 3000,
  onError,
}: UseDeviceStreamOptions): UseDeviceStreamResult {
  const [device, setDevice] = useState<SdkDevice | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<unknown>(undefined);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Latest handle, read by load(); the effect is keyed by id/api, not identity.
  const deviceHandleRef = useRef(deviceHandle);
  deviceHandleRef.current = deviceHandle;
  const handleId = deviceHandle?.id;
  const handleApi = deviceHandle?.api;

  // Bumping this triggers a re-fetch without changing the polling cadence.
  const [fetchEpoch, setFetchEpoch] = useState(0);
  const refetch = useCallback(() => setFetchEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!enabled || !(handleId || (client && deviceId))) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const next = await fetchDeviceInfo({ client, deviceId, device: deviceHandleRef.current });
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
  }, [client, deviceId, handleId, handleApi, enabled, pollIntervalMs, fetchEpoch]);

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
