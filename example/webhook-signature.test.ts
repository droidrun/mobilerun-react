// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';

const secret = 'whsec_test';
const now = 1_800_000_000_000;
const ts = String(now);
const body = '{"type":"task.run.approval_requested","data":{"taskId":"t1"}}';
const good = () => ({ secret, timestamp: ts, signature: signWebhook(secret, ts, body), rawBody: body, nowMs: now });

describe('verifyWebhookSignature', () => {
  test('accepts a valid signature', () => {
    expect(verifyWebhookSignature(good())).toBe(true);
  });
  test('rejects a wrong secret', () => {
    expect(verifyWebhookSignature({ ...good(), secret: 'other' })).toBe(false);
  });
  test('rejects a tampered body', () => {
    expect(verifyWebhookSignature({ ...good(), rawBody: body.replace('t1', 't2') })).toBe(false);
  });
  test('rejects a missing sha256= prefix', () => {
    const g = good();
    expect(verifyWebhookSignature({ ...g, signature: g.signature.slice('sha256='.length) })).toBe(false);
  });
  test('rejects missing headers and wrong length', () => {
    expect(verifyWebhookSignature({ ...good(), signature: null })).toBe(false);
    expect(verifyWebhookSignature({ ...good(), timestamp: undefined })).toBe(false);
    expect(verifyWebhookSignature({ ...good(), signature: 'sha256=abcd' })).toBe(false);
  });
  test('rejects drift over 5 minutes, accepts just under', () => {
    expect(verifyWebhookSignature({ ...good(), nowMs: now + 5 * 60_000 + 1 })).toBe(false);
    expect(verifyWebhookSignature({ ...good(), nowMs: now - 5 * 60_000 - 1 })).toBe(false);
    expect(verifyWebhookSignature({ ...good(), nowMs: now + 5 * 60_000 - 1 })).toBe(true);
  });
});
