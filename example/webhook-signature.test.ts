// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyWebhook, WebhookVerificationError } from '@mobilerun/sdk';

const secret = 'whsec_test';
const now = 1_800_000_000_000;
const timestamp = String(now);
const body = '{"type":"task.run.approval_requested","data":{"taskId":"t1"}}';
const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
const options = {
  body: new TextEncoder().encode(body),
  headers: { 'x-mobilerun-timestamp': timestamp, 'x-mobilerun-signature': signature },
  secret,
  now,
};

describe('SDK webhook verification used by the example', () => {
  test('accepts signed raw bytes and returns the payload', async () => {
    expect(await verifyWebhook(options)).toEqual(JSON.parse(body));
  });

  test('rejects a tampered body', async () => {
    await expect(verifyWebhook({ ...options, body: body.replace('t1', 't2') })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  test('rejects a timestamp outside the five-minute window', async () => {
    await expect(verifyWebhook({ ...options, now: now + 300_001 })).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
