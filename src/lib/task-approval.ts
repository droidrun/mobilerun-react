// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

/**
 * A human approval a running task is waiting for. The webhook `data` of
 * `task.run.approval_requested` and `pendingApproval` on `GET /tasks/{id}`
 * share this shape.
 */
export interface PendingApproval {
  approvalId: string;
  /** `payment_card` today; new kinds may appear. */
  kind: string;
  /** payment_card: `{ label?, credentialName?, targetPackage, targetHost? }`. */
  details: Record<string, unknown>;
  /** ISO 8601. */
  expiresAt: string;
  deviceId?: string | null;
}

export type ApprovalDecision = 'approve' | 'deny';

export interface PaymentCardDetails {
  /** Display name of the card (`label`, falling back to `credentialName`). */
  card: string;
  targetPackage: string;
  targetHost?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * Plain type guard for `payment_card` details. Returns undefined when invalid.
 * Wrong-typed optional fields count as absent.
 */
export function parsePaymentCardDetails(details: unknown): PaymentCardDetails | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const d = details as Record<string, unknown>;
  const targetPackage = str(d.targetPackage);
  const card = str(d.label) ?? str(d.credentialName);
  if (!targetPackage || !card) return undefined;
  const targetHost = str(d.targetHost);
  return { card, targetPackage, ...(targetHost ? { targetHost } : {}) };
}

/** Milliseconds until `expiresAt` (negative once past); 0 when unparsable. Display only. */
export function remainingMs(expiresAt: string, nowMs: number): number {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? 0 : at - nowMs;
}

/** `4m 58s`, `1h 2m 3s` from one hour up (minutes and seconds always shown), `45s` below a minute. Clamps at zero. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
