// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

/**
 * Why a stream connection attempt failed (stream client contract v1).
 *
 * - `credentials_unavailable`: `tokenProvider` threw, timed out or returned an empty key.
 * - `connection_refused`: the signaling WebSocket closed before it opened. A browser cannot
 *   see the HTTP status, so a rejected, used or expired key, a wrong device and a refused
 *   origin all land here.
 * - `disconnected`: an open session dropped (includes the server's session cap).
 * - `device_unavailable`: the server reported the device offline or not ready. The current
 *   signaling protocol has no such message, so this package does not report it yet.
 * - `unknown`: anything else, e.g. a handshake timeout.
 */
export type StreamErrorReason =
  | 'credentials_unavailable'
  | 'connection_refused'
  | 'disconnected'
  | 'device_unavailable'
  | 'unknown';

/**
 * What a single failed attempt looked like, before the reconnect policy adds its counters.
 * `message` is always SDK-owned text: exception messages from `tokenProvider` or the socket
 * can carry a stream key or a `?token=` URL and are never forwarded.
 */
export interface StreamFailure {
  reason: StreamErrorReason;
  message: string;
}

/** Fixed, credential-free text for a failure whose cause is an arbitrary exception. */
export const STREAM_FAILURE_MESSAGES: Record<StreamErrorReason, string> = {
  credentials_unavailable: 'Stream key provider failed',
  connection_refused: 'Signaling connection closed before it opened',
  disconnected: 'The stream connection dropped',
  device_unavailable: 'The device is unavailable',
  unknown: 'Stream connection attempt failed',
};

/** Payload of `onError`. */
export interface StreamError extends StreamFailure {
  /** Consecutive failed attempts in the current reconnect cycle, starting at 1. */
  attempt: number;
  /** True when the SDK stops retrying; the Retry button stays available. */
  final: boolean;
}

/** User-visible strings of `DeviceStream`; every key is optional and has an English default. */
export interface DeviceStreamLabels {
  /** Pill while the stream has no URL yet or is negotiating. Default `connecting`. */
  connecting: string;
  /** Pill while reconnecting after a drop; ` (n/6)` is appended from the second attempt. Default `reconnecting`. */
  disconnected: string;
  /** Message once retries are exhausted. Default `device stream unavailable`. */
  unavailable: string;
  /** Retry button text. Default `Retry`. */
  retry: string;
}

const DEFAULT_DEVICE_STREAM_LABELS: DeviceStreamLabels = {
  connecting: 'connecting',
  disconnected: 'reconnecting',
  unavailable: 'device stream unavailable',
  retry: 'Retry',
};

/** Fills every label the integrator left out (or set to undefined) with its English default. */
export function resolveDeviceStreamLabels(overrides?: Partial<DeviceStreamLabels>): DeviceStreamLabels {
  return {
    connecting: overrides?.connecting ?? DEFAULT_DEVICE_STREAM_LABELS.connecting,
    disconnected: overrides?.disconnected ?? DEFAULT_DEVICE_STREAM_LABELS.disconnected,
    unavailable: overrides?.unavailable ?? DEFAULT_DEVICE_STREAM_LABELS.unavailable,
    retry: overrides?.retry ?? DEFAULT_DEVICE_STREAM_LABELS.retry,
  };
}
