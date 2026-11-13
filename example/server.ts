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
//   • Local use only: the server binds to 127.0.0.1 and its task routes and SSE
//     route are unauthenticated by design. If you expose anything publicly (e.g. a
//     tunnel for webhook testing), forward only /webhooks/mobilerun, never the
//     whole server.
//   • Task approvals: GET /api/v1/tasks/:taskId (pending approval), POST
//     /api/v1/tasks/:taskId/approvals/:approvalId (decision), POST /webhooks/mobilerun
//     (signed webhook, set MOBILERUN_WEBHOOK_SECRET) and GET /api/v1/events (SSE
//     change signal for the browser).
//
// Run:  MOBILERUN_API_KEY=dr_sk_… bun run example  (or put it in a .env file)

import type { Server } from 'bun';
import Mobilerun from '@mobilerun/sdk';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import { verifyWebhookSignature } from './webhook-signature';
import index from './index.html';

const API_KEY = process.env.MOBILERUN_API_KEY;
const UPSTREAM = process.env.MOBILERUN_API_URL?.replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.MOBILERUN_WEBHOOK_SECRET;
const PORT = Number(process.env.PORT ?? 3000);
const client = API_KEY ? new Mobilerun({ apiKey: API_KEY, ...(UPSTREAM ? { baseURL: `${UPSTREAM}/v1` } : {}) }) : null;

if (!API_KEY) {
  console.warn(
    '\n  ! MOBILERUN_API_KEY is not set.\n' +
      '    Manual URL mode still works. SDK mode needs a key in .env or:\n' +
      '    MOBILERUN_API_KEY=dr_sk_… bun run example\n',
  );
}

const app = new Hono<{ Bindings: Server<unknown> }>();

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

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** Maps an upstream API error to a response, passing 4xx/5xx through (404/409 let the UI refetch). */
function upstreamFailure(c: Context, error: string, err: unknown) {
  const { status, message } = err as { status?: number; message?: string };
  console.error(`✗ ${error}`, JSON.stringify(c.req.param()), message ?? String(err));
  const code = (status && status >= 400 && status < 600 ? status : 502) as ContentfulStatusCode;
  return c.json({ error, detail: message ?? String(err) }, code);
}

// A real app authenticates the caller and checks that the task belongs to that
// user/org before forwarding. This example is unauthenticated and local-only.
app.get('/api/v1/tasks/:taskId', async (c) => {
  if (!client) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use task approvals.' }, 500);
  }
  const taskId = c.req.param('taskId');
  if (!ID_PATTERN.test(taskId)) return c.json({ error: 'invalid_id' }, 400);
  try {
    // The installed SDK's task type may not carry pendingApproval yet, so read the raw response.
    const { task } = await client.get<{ task?: { pendingApproval?: unknown } }>(`/tasks/${encodeURIComponent(taskId)}`);
    return c.json({ pendingApproval: task?.pendingApproval ?? null });
  } catch (err) {
    return upstreamFailure(c, 'task_retrieve_failed', err);
  }
});

// Same rule as above: authenticate the caller and check task ownership before forwarding.
app.post('/api/v1/tasks/:taskId/approvals/:approvalId', async (c) => {
  if (!client) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use task approvals.' }, 500);
  }
  const taskId = c.req.param('taskId');
  const approvalId = c.req.param('approvalId');
  if (!ID_PATTERN.test(taskId) || !ID_PATTERN.test(approvalId)) return c.json({ error: 'invalid_id' }, 400);
  const body = (await c.req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    return c.json({ error: 'invalid_decision', detail: "decision must be 'approve' or 'deny'." }, 422);
  }
  try {
    // Becomes client.tasks.approvals.decide(...) once the SDK ships that method.
    await client.post(`/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, {
      body: { decision },
    });
    return c.body(null, 204);
  } catch (err) {
    return upstreamFailure(c, 'approval_decide_failed', err);
  }
});

// SSE subscribers. A real app scopes this per signed-in user/org instead of
// broadcasting every event to every browser.
type ApprovalSignal = { taskId: string };
const subscribers = new Set<(signal: ApprovalSignal) => void>();

app.get('/api/v1/events', (c) => {
  // Bun closes idle requests after 10 s; exempt this long-lived stream only.
  c.env.timeout(c.req.raw, 0);
  return streamSSE(c, async (stream) => {
    const send = (signal: ApprovalSignal) => void stream.writeSSE({ data: JSON.stringify(signal) });
    subscribers.add(send);
    stream.onAbort(() => subscribers.delete(send));
    // Keep the connection open until the client goes away.
    while (!stream.aborted && !stream.closed) {
      await stream.writeSSE({ event: 'ping', data: '' });
      await stream.sleep(25_000);
    }
    subscribers.delete(send);
  });
});

const APPROVAL_EVENTS = new Set(['task.run.approval_requested', 'task.run.approval_resolved']);

app.post('/webhooks/mobilerun', async (c) => {
  if (!WEBHOOK_SECRET) return c.json({ error: 'missing_webhook_secret' }, 500);
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413);
  }
  // Raw bytes exactly as received; verify before parsing.
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const ok = verifyWebhookSignature({
    secret: WEBHOOK_SECRET,
    timestamp: c.req.header('X-Mobilerun-Timestamp'),
    signature: c.req.header('X-Mobilerun-Signature'),
    rawBody: bytes,
  });
  if (!ok) return c.json({ error: 'invalid_signature' }, 401);

  let event: { type?: unknown; data?: { taskId?: unknown } } | null = null;
  try {
    event = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Verified but not JSON: nothing to broadcast.
  }
  const taskId = event?.data?.taskId;
  if (typeof event?.type === 'string' && APPROVAL_EVENTS.has(event.type) && typeof taskId === 'string') {
    for (const send of subscribers) send({ taskId });
  }
  return c.body(null, 204);
});

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  routes: { '/': index }, // Bun bundles + serves the React UI and its assets
  development: { hmr: true, console: true },
  fetch: app.fetch,
});

console.log(`\n  ▸ @mobilerun/react dev harness   http://localhost:${PORT}`);
console.log(`  ▸ SDK helper    GET /api/v1/devices/:id      →  ${client?.baseURL ?? 'https://api.mobilerun.ai/v1'}/devices/:id`);
console.log('  ▸ approvals     GET/POST /api/v1/tasks/:id…  ·  POST /webhooks/mobilerun  ·  GET /api/v1/events');
console.log('  ▸ stream WS     direct browser connection using ?token=\n');
