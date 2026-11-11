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
//   • Task approvals: GET /api/v1/tasks/:taskId (pending approval), POST
//     /api/v1/tasks/:taskId/approvals/:approvalId (decision), POST /webhooks/mobilerun
//     (signed webhook, set MOBILERUN_WEBHOOK_SECRET) and GET /api/v1/events (SSE
//     change signal for the browser).
//
// Run:  MOBILERUN_API_KEY=dr_sk_… bun run example  (or put it in a .env file)

import Mobilerun from '@mobilerun/sdk';
import { Hono } from 'hono';
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

function upstreamStatus(err: unknown): number {
  const status = (err as { status?: number }).status;
  return status && status >= 400 && status < 600 ? status : 502;
}

// Narrow local type: the installed SDK's task type may not carry pendingApproval yet.
interface TaskWithApproval {
  status?: string;
  pendingApproval?: unknown;
}

app.get('/api/v1/tasks/:taskId', async (c) => {
  if (!client) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use task approvals.' }, 500);
  }
  const taskId = c.req.param('taskId');
  try {
    const task = await client.get<TaskWithApproval>(`/tasks/${encodeURIComponent(taskId)}`);
    return c.json({ status: task.status, pendingApproval: task.pendingApproval ?? null });
  } catch (err) {
    const message = (err as { message?: string }).message ?? String(err);
    console.error(`✗ task retrieve ${taskId} failed:`, message);
    return c.json({ error: 'task_retrieve_failed', detail: message }, upstreamStatus(err) as 400);
  }
});

app.post('/api/v1/tasks/:taskId/approvals/:approvalId', async (c) => {
  if (!client) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use task approvals.' }, 500);
  }
  const body = (await c.req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    return c.json({ error: 'invalid_decision', detail: "decision must be 'approve' or 'deny'." }, 422);
  }
  const taskId = c.req.param('taskId');
  const approvalId = c.req.param('approvalId');
  try {
    // Becomes client.tasks.approvals.decide(...) once the SDK ships that method.
    await client.post(`/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, {
      body: { decision },
    });
    return c.body(null, 204);
  } catch (err) {
    const message = (err as { message?: string }).message ?? String(err);
    console.error(`✗ approval decide ${taskId}/${approvalId} failed:`, message);
    // 404 (unknown) and 409 (already resolved/expired) pass through so the UI can refetch.
    return c.json({ error: 'approval_decide_failed', detail: message }, upstreamStatus(err) as 400);
  }
});

// SSE subscribers. A real app scopes this per signed-in user/org instead of
// broadcasting every event to every browser.
type ApprovalSignal = { type: string; taskId: unknown; approvalId: unknown };
const subscribers = new Set<(signal: ApprovalSignal) => void>();

app.get('/api/v1/events', (c) =>
  streamSSE(c, async (stream) => {
    const send = (signal: ApprovalSignal) => void stream.writeSSE({ data: JSON.stringify(signal) });
    subscribers.add(send);
    stream.onAbort(() => subscribers.delete(send));
    // Keep the connection open until the client goes away.
    while (!stream.aborted && !stream.closed) {
      await stream.writeSSE({ event: 'ping', data: '' });
      await stream.sleep(25_000);
    }
    subscribers.delete(send);
  }),
);

const APPROVAL_EVENTS = new Set(['task.run.approval_requested', 'task.run.approval_resolved']);

app.post('/webhooks/mobilerun', async (c) => {
  if (!WEBHOOK_SECRET) return c.json({ error: 'missing_webhook_secret' }, 500);
  const rawBody = await c.req.text(); // exactly as received; verify before parsing
  const ok = verifyWebhookSignature({
    secret: WEBHOOK_SECRET,
    timestamp: c.req.header('X-Mobilerun-Timestamp'),
    signature: c.req.header('X-Mobilerun-Signature'),
    rawBody,
  });
  if (!ok) return c.json({ error: 'invalid_signature' }, 401);

  let event: { type?: unknown; data?: { taskId?: unknown; approvalId?: unknown } } | null = null;
  try {
    event = JSON.parse(rawBody);
  } catch {
    // Verified but not JSON: nothing to broadcast.
  }
  if (event && typeof event.type === 'string' && APPROVAL_EVENTS.has(event.type)) {
    const signal = { type: event.type, taskId: event.data?.taskId, approvalId: event.data?.approvalId };
    for (const send of subscribers) send(signal);
  }
  return c.body(null, 204);
});

Bun.serve({
  port: PORT,
  routes: { '/': index }, // Bun bundles + serves the React UI and its assets
  development: { hmr: true, console: true },
  fetch: app.fetch,
});

console.log(`\n  ▸ @mobilerun/react dev harness   http://localhost:${PORT}`);
console.log(`  ▸ SDK helper    GET /api/v1/devices/:id      →  ${client?.baseURL ?? 'https://api.mobilerun.ai/v1'}/devices/:id`);
console.log('  ▸ approvals     GET/POST /api/v1/tasks/:id…  ·  POST /webhooks/mobilerun  ·  GET /api/v1/events');
console.log('  ▸ stream WS     direct browser connection using ?token=\n');
