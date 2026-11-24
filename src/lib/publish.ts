// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

export type PublishOptions = { audio: boolean; video?: boolean };
export type PublishKind = 'audio' | 'video';
export type PublishPhase = 'idle' | 'capturing' | 'starting' | 'accepted' | 'active' | 'stopped' | 'error';
export type PublishFailureReason = 'publish_not_allowed' | 'publish_unsupported' | 'permission_denied'
  | 'publish_busy' | 'publish_failed' | 'publish_timeout' | 'publish_cancelled' | 'disconnected';
export type PublishFailure = {
  reason: PublishFailureReason;
  message: string;
  detail?: string;
  serverReason?: string;
};
export type PublishState = {
  phase: PublishPhase;
  mediaSessionId: string | null;
  kinds: PublishKind[];
  reason?: PublishFailureReason | 'stopped_by_client';
  message?: string;
  detail?: string;
  serverReason?: string;
};
export type DevicePublishCapabilities = {
  microphoneInjection: boolean;
  cameraInjection: boolean;
  mediaInjectionTransport?: string;
};
export type PublishErrorEvent = PublishFailure & { mediaSessionId?: string };

/** Structured rejection from startPublish; branch on reason/detail, not message. */
export class PublishError extends Error implements PublishFailure {
  readonly reason: PublishFailureReason;
  readonly detail?: string;
  readonly serverReason?: string;
  constructor(failure: PublishFailure) {
    super(failure.message);
    this.name = 'PublishError';
    this.reason = failure.reason;
    this.detail = failure.detail;
    this.serverReason = failure.serverReason;
  }
}

export const INITIAL_PUBLISH_STATE: PublishState = Object.freeze({
  phase: 'idle', mediaSessionId: null, kinds: Object.freeze([]) as unknown as PublishKind[],
});

export function supportsPublish(capabilities?: DevicePublishCapabilities): boolean {
  return capabilities?.microphoneInjection === true && capabilities.mediaInjectionTransport === 'direct';
}
