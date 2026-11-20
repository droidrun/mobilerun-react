// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from 'bun:test';
import { MobilerunSDK } from '@mobilerun/sdk';
import { createExampleApp } from './server';

const deviceId = '11111111-1111-4111-8111-111111111111';

// Fake only the external HTTP API; routes and the SDK's request handling stay real.
function upstream(response: object, status = 200) {
  const requests: Request[] = [];
  const sdk = new MobilerunSDK({
    apiKey: 'test-only-placeholder',
    baseURL: 'https://api.example.invalid/v1',
    logLevel: 'off',
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(response, { status });
    },
  });
  return { app: createExampleApp(sdk), requests };
}

test('stream key helper GET returns URL and state without old credentials', async () => {
  const f = upstream({
    id: deviceId,
    state: 'ready',
    streamUrl: 'wss://stream.example.invalid/device',
    streamToken: 'legacy-static',
  });
  const response = await f.app.request(`/api/v1/devices/${deviceId}`, {
    headers: { Host: 'localhost:3000' },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: '11111111-1111-4111-8111-111111111111',
    state: 'ready',
    streamUrl: 'wss://stream.example.invalid/device',
  });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].url).toBe(
    'https://api.example.invalid/v1/devices/11111111-1111-4111-8111-111111111111',
  );
});

test('stream key helper POST mints once and returns only the flat no-store DTO', async () => {
  // Literal public identity contract, with extra upstream data to verify the projection.
  const f = upstream({
    key: 'single-use-key',
    keyId: 'key-id',
    expiresAt: '2026-11-18T12:02:00.000Z',
    extra: 'must-not-be-forwarded',
  }, 201);
  const response = await f.app.request(`/api/v1/devices/${deviceId}/stream-key`, {
    method: 'POST',
    headers: { Host: 'localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'ignored-device', ttlSeconds: 300, owner: 'ignored' }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    key: 'single-use-key',
    keyId: 'key-id',
    expiresAt: '2026-11-18T12:02:00.000Z',
  });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].method).toBe('POST');
  expect(f.requests[0].url).toBe('https://api.example.invalid/v1/identity/stream-keys');
  expect(await f.requests[0].json()).toEqual({
    deviceId: '11111111-1111-4111-8111-111111111111', ttlSeconds: 120,
  });
  expect(f.requests[0].headers.get('Authorization')).toBe('Bearer test-only-placeholder');
});

test.each([403, 503])('stream key helper propagates refusal %i without retry or error detail', async (status) => {
  const f = upstream({ message: 'sensitive upstream detail' }, status);
  const log = spyOn(console, 'error').mockImplementation(() => {});
  let response: Response;
  try {
    response = await f.app.request(`/api/v1/devices/${deviceId}/stream-key`, {
      method: 'POST',
      headers: { Host: 'localhost:3000' },
    });
    expect(log.mock.calls).toEqual([['stream_key_mint_failed', status]]);
  } finally {
    log.mockRestore();
  }
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'stream_key_mint_failed' });
  expect(f.requests).toHaveLength(1);
});

test('stream key helper rejects an invalid device id before calling upstream', async () => {
  const f = upstream({ key: 'unused' }, 201);
  const response = await f.app.request('/api/v1/devices/invalid.id/stream-key', {
    method: 'POST',
    headers: { Host: 'localhost:3000' },
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'invalid_id' });
  expect(f.requests).toEqual([]);
});

test('stream key helper rejects a foreign Host before calling upstream', async () => {
  const f = upstream({ key: 'unused' }, 201);
  const response = await f.app.request(`/api/v1/devices/${deviceId}/stream-key`, {
    method: 'POST',
    headers: { Host: 'attacker.example:3000' },
  });
  expect(response.status).toBe(403);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'forbidden' });
  expect(f.requests).toEqual([]);
});

test('stream key helper rejects a foreign Origin before calling upstream', async () => {
  const f = upstream({ key: 'unused' }, 201);
  const response = await f.app.request(`/api/v1/devices/${deviceId}/stream-key`, {
    method: 'POST',
    headers: { Host: 'localhost:3000', Origin: 'http://attacker.example:3000' },
  });
  expect(response.status).toBe(403);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'forbidden' });
  expect(f.requests).toEqual([]);
});

test.each([
  ['127.0.0.1:3000', 'http://127.0.0.1:3000'],
  ['localhost:3000', 'http://localhost:3000'],
  ['[::1]:3000', 'http://[::1]:3000'],
])('stream key helper accepts same-origin requests for %s', async (host, origin) => {
  const f = upstream({ key: 'single-use-key', keyId: 'key-id', expiresAt: '2026-11-18T12:02:00.000Z' }, 201);
  const response = await f.app.request(`/api/v1/devices/${deviceId}/stream-key`, {
    method: 'POST',
    headers: { Host: host, Origin: origin },
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    key: 'single-use-key', keyId: 'key-id', expiresAt: '2026-11-18T12:02:00.000Z',
  });
  expect(f.requests).toHaveLength(1);
});

test('webhook validation is unaffected by foreign Host and Origin headers', async () => {
  const f = upstream({});
  const local = await f.app.request('/webhooks/mobilerun', {
    method: 'POST',
    headers: { Host: 'localhost:3000' },
    body: '{}',
  });
  const tunneled = await f.app.request('/webhooks/mobilerun', {
    method: 'POST',
    headers: { Host: 'tunnel.example', Origin: 'https://sender.example' },
    body: '{}',
  });
  expect([401, 500]).toContain(local.status);
  expect(tunneled.status).toBe(local.status);
  expect(await tunneled.json()).toEqual(await local.json());
  expect(f.requests).toEqual([]);
});
