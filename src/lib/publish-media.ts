// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { supportsPublish, type DevicePublishCapabilities, type PublishKind } from './publish';

export type PublishReservations = {
  transceivers: Partial<Record<PublishKind, RTCRtpTransceiver>>;
  offered: Set<PublishKind>;
};

const H264_PUBLISH_PROFILE = /(?:^|;)\s*profile-level-id=(42e0|42c0|4d00|640c)([0-9a-f]{2})(?:;|$)/i;

function codecs(kind: PublishKind): RTCRtpCodec[] {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return [];
  return (RTCRtpSender.getCapabilities(kind)?.codecs ?? []).filter(codec => {
    if (kind === 'audio') return codec.mimeType.toLowerCase() === 'audio/opus' && codec.clockRate === 48000 && codec.channels === 2;
    const fmtp = codec.sdpFmtpLine ?? '';
    const profile = fmtp.match(H264_PUBLISH_PROFILE);
    return codec.mimeType.toLowerCase() === 'video/h264' && /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(fmtp)
      && !!profile && Number.parseInt(profile[2], 16) >= 0x1f;
  }).sort((a, b) => Number(!/profile-level-id=42/i.test(a.sdpFmtpLine ?? '')) - Number(!/profile-level-id=42/i.test(b.sdpFmtpLine ?? '')));
}

export function supportsPublishCamera(): boolean { return codecs('video').length > 0; }

/** Trackless reservations in the first offer, after both downstream sections. */
export function reservePublish(pc: RTCPeerConnection, capabilities?: DevicePublishCapabilities): PublishReservations {
  const result: PublishReservations = { transceivers: {}, offered: new Set() };
  if (!supportsPublish(capabilities)) return result;
  for (const kind of ['video', 'audio'] as const) {
    const preferences = codecs(kind);
    if ((kind === 'video' && !capabilities?.cameraInjection) || !preferences.length) continue;
    try {
      const transceiver = pc.addTransceiver(kind, {
        direction: 'sendonly',
        ...(kind === 'video' ? { sendEncodings: [{ maxBitrate: 1_000_000 }] } : {}),
      });
      transceiver.setCodecPreferences(preferences);
      result.transceivers[kind] = transceiver;
    } catch {
      // Preserve viewing on implementations without usable codec preferences.
    }
  }
  return result;
}

/** Verify browser-generated SSRC-bearing upstream sections; never rewrite SDP. */
export function inspectPublishOffer(reservations: PublishReservations, sdp: string): void {
  const sections = sdp.split(/(?=^m=)/m);
  for (const kind of ['audio', 'video'] as const) {
    const transceiver = reservations.transceivers[kind];
    const section = sections.find(part => transceiver?.mid != null && part.split(/\r?\n/).includes(`a=mid:${transceiver.mid}`));
    const codec = kind === 'audio' ? /a=rtpmap:\d+ opus\/48000\/2/i : /a=rtpmap:\d+ H264\/90000/i;
    if (section && /^a=sendonly\r?$/m.test(section) && /^a=ssrc:\d+ /m.test(section) && codec.test(section)) {
      reservations.offered.add(kind);
    }
  }
}

export function usablePublishSender(reservations: PublishReservations, kind: PublishKind): RTCRtpSender | undefined {
  const transceiver = reservations.transceivers[kind];
  return reservations.offered.has(kind) && transceiver
    && (transceiver.currentDirection === 'sendonly' || transceiver.currentDirection === 'sendrecv')
    ? transceiver.sender : undefined;
}
