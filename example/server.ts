// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0
//
// Dev harness server for the @mobilerun/react example.
//
// The stream WebSocket is not proxied: the browser connects to the SDK-provided
// streamUrl directly, and @mobilerun/react appends streamToken as ?token=.
//
// For SDK mode, this Bun + Hono server exposes one narrow endpoint that uses the
// official SDK to retrieve streamUrl + streamToken without exposing a secret API key:
//
//   browser ──(same-origin)──▶ this server ──(@mobilerun/sdk)──▶ API
//
//   • Serves the example UI (Bun bundles index.html + main.tsx).
//   • Handles GET /api/v1/devices/:deviceId via Mobilerun.devices.retrieve().
//
// Run:  MOBILERUN_API_KEY=dr_sk_… bun run example  (or put it in a .env file)

import Mobilerun from '@mobilerun/sdk';
import { Hono } from 'hono';
import index from './index.html';

const API_KEY = process.env.MOBILERUN_API_KEY;
const UPSTREAM = process.env.MOBILERUN_API_URL?.replace(/\/+$/, '');
const PORT = Number(process.env.PORT ?? 3000);
const client = API_KEY ? new Mobilerun({ apiKey: API_KEY, ...(UPSTREAM ? { baseURL: `${UPSTREAM}/v1` } : {}) }) : null;

if (!API_KEY) {
  console.warn(
    '\n  ! MOBILERUN_API_KEY is not set.\n' +
      '    Manual URL mode still works. SDK mode needs a key in .env or:\n' +
      '    MOBILERUN_API_KEY=dr_sk_… bun run example\n',
  );
}

const app = new Hono();

app.get('/api/v1/devices/:deviceId', async (c) => {
  if (!client) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use SDK mode.' }, 500);
  }

  try {
    const device = await client.devices.retrieve(c.req.param('deviceId'));
    return c.json(device);
  } catch (err) {
    const apiError = err as { status?: number; message?: string };
    const status = apiError.status && apiError.status >= 400 && apiError.status < 600 ? apiError.status : 502;
    console.error(`✗ devices.retrieve ${c.req.param('deviceId')} failed:`, apiError.message ?? String(err));
    return c.json({ error: 'device_retrieve_failed', detail: apiError.message ?? String(err) }, status);
  }
});

Bun.serve({
  port: PORT,
  routes: { '/': index }, // Bun bundles + serves the React UI and its assets
  development: { hmr: true, console: true },
  fetch: app.fetch,
});

console.log(`\n  ▸ @mobilerun/react dev harness   http://localhost:${PORT}`);
console.log(`  ▸ SDK helper    GET /api/v1/devices/:id      →  ${client?.baseURL ?? 'https://api.mobilerun.ai/v1'}/devices/:id`);
console.log('  ▸ stream WS     direct browser connection using ?token=\n');
