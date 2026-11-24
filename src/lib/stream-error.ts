// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import type { PublishFailureReason } from './publish';

/**
 * Why a stream connection attempt failed (stream client contract v1).
 *
 * - `credentials_unavailable`: `tokenProvider` threw, timed out or returned an empty stream token.
 * - `connection_refused`: the signaling WebSocket closed before it opened. A browser cannot
 *   see the HTTP status, so a rejected, used or expired stream token, a wrong device and a refused
 *   origin all land here.
 * - `disconnected`: an open session dropped (includes the server's session cap).
 * - `device_unavailable`: the server reported the device offline or not ready. The current
 *   signaling protocol has no such message, so this package does not report it yet.
 * - `unknown`: anything else, e.g. a handshake timeout.
 */
export type ConnectionErrorReason =
  | 'credentials_unavailable'
  | 'connection_refused'
  | 'disconnected'
  | 'device_unavailable'
  | 'unknown';

/**
 * What a single failed attempt looked like, before the reconnect policy adds its counters.
 * `message` is always SDK-owned text: exception messages from `tokenProvider` or the socket
 * can carry a stream token or a `?token=` URL and are never forwarded.
 */
export interface StreamFailure {
  reason: ConnectionErrorReason;
  message: string;
}

/** Fixed, credential-free text for a failure whose cause is an arbitrary exception. */
export const STREAM_FAILURE_MESSAGES: Record<ConnectionErrorReason, string> = {
  credentials_unavailable: 'Stream token provider failed',
  connection_refused: 'Signaling connection closed before it opened',
  disconnected: 'The stream connection dropped',
  device_unavailable: 'The device is unavailable',
  unknown: 'Stream connection attempt failed',
};

export type StreamErrorReason = ConnectionErrorReason | PublishFailureReason;

/** Payload of `onError`; publish failures never change the viewer retry state. */
export interface StreamError {
  reason: StreamErrorReason;
  message: string;
  operation?: 'publish';
  mediaSessionId?: string;
  detail?: string;
  serverReason?: string;
  /**
   * Consecutive failed attempts in the current reconnect cycle: 1 for the failed first connect,
   * up to 7 (the first connect plus 6 retries), which is the `final` one. It is the same number
   * the reconnect pill shows as `(n/6)` while retry n is pending; the pill is gone once `final`.
   */
  attempt: number;
  /** True when the SDK stops retrying; the Retry button stays available. */
  final: boolean;
}

/** User-visible strings of `DeviceStream`; every key is optional and has an English default. */
export interface DeviceStreamLabels {
  /** Pill while the stream has no URL yet or is negotiating. Default `connecting`. */
  connecting: string;
  /** Pill while reconnecting after a drop; ` (n/6)` is appended from the first retry. Default `reconnecting`. */
  disconnected: string;
  /** Message once retries are exhausted. Default `device stream unavailable`. */
  unavailable: string;
  /** Retry button text. Default `Retry`. */
  retry: string;
  microphone: string;
  camera: string;
  stopMicrophone: string;
  stopCamera: string;
  publishStarting: string;
  publishPermissionDenied: string;
  publishNotAllowed: string;
  publishFailed: string;
}

const DEFAULT_DEVICE_STREAM_LABELS: DeviceStreamLabels = {
  connecting: 'connecting',
  disconnected: 'reconnecting',
  unavailable: 'device stream unavailable',
  retry: 'Retry',
  microphone: 'Microphone',
  camera: 'Camera',
  stopMicrophone: 'Stop microphone',
  stopCamera: 'Stop camera',
  publishStarting: 'Starting inputs',
  publishPermissionDenied: 'Microphone or camera permission denied',
  publishNotAllowed: 'Publishing is not allowed',
  publishFailed: 'Could not publish inputs',
};

/** Fills every label the integrator left out (or set to undefined) with its English default. */
export function resolveDeviceStreamLabels(overrides?: Partial<DeviceStreamLabels>): DeviceStreamLabels {
  return {
    connecting: overrides?.connecting ?? DEFAULT_DEVICE_STREAM_LABELS.connecting,
    disconnected: overrides?.disconnected ?? DEFAULT_DEVICE_STREAM_LABELS.disconnected,
    unavailable: overrides?.unavailable ?? DEFAULT_DEVICE_STREAM_LABELS.unavailable,
    retry: overrides?.retry ?? DEFAULT_DEVICE_STREAM_LABELS.retry,
    microphone: overrides?.microphone ?? DEFAULT_DEVICE_STREAM_LABELS.microphone,
    camera: overrides?.camera ?? DEFAULT_DEVICE_STREAM_LABELS.camera,
    stopMicrophone: overrides?.stopMicrophone ?? DEFAULT_DEVICE_STREAM_LABELS.stopMicrophone,
    stopCamera: overrides?.stopCamera ?? DEFAULT_DEVICE_STREAM_LABELS.stopCamera,
    publishStarting: overrides?.publishStarting ?? DEFAULT_DEVICE_STREAM_LABELS.publishStarting,
    publishPermissionDenied: overrides?.publishPermissionDenied ?? DEFAULT_DEVICE_STREAM_LABELS.publishPermissionDenied,
    publishNotAllowed: overrides?.publishNotAllowed ?? DEFAULT_DEVICE_STREAM_LABELS.publishNotAllowed,
    publishFailed: overrides?.publishFailed ?? DEFAULT_DEVICE_STREAM_LABELS.publishFailed,

  };
}

/** Reconnect pill text: the label plus `(n/max)` for retry n, n counted as in `StreamError.attempt`. */
export function reconnectPillLabel(label: string, attempt: number, maxAttempts: number): string {
  return attempt >= 1 ? `${label} (${attempt}/${maxAttempts})` : label;
}
