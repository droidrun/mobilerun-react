// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0
//
// Verifies a Mobilerun webhook delivery. Headers: `X-Mobilerun-Timestamp`
// (Unix ms) and `X-Mobilerun-Signature: sha256=<lowercase hex>`, an HMAC-SHA256
// of `"{timestamp}.{rawBody}"` with the endpoint secret. Verify before parsing.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_MAX_DRIFT_MS = 5 * 60 * 1000;

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { secret, timestamp, signature, rawBody, nowMs = Date.now() } = input;
  if (!timestamp || !signature || !signature.startsWith('sha256=')) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs - Number(timestamp)) > WEBHOOK_MAX_DRIFT_MS) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
