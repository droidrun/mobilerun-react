'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, Check, Clock, CreditCard, Globe, Loader2, X, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  formatRemaining,
  parsePaymentCardDetails,
  remainingMs,
  type ApprovalDecision,
  type PendingApproval,
} from '../lib/task-approval';
import { Button } from './ui/button';

export interface TaskApprovalLabels {
  /** Heading for a `payment_card` approval. */
  paymentCardTitle: string;
  /** Heading and body for unknown kinds / invalid details. */
  waiting: string;
  card: string;
  app: string;
  domain: string;
  /** `{time}` is replaced with the remaining time, e.g. `4:32`. */
  timeLeft: string;
  expired: string;
  approve: string;
  deny: string;
}

const DEFAULT_LABELS: TaskApprovalLabels = {
  paymentCardTitle: 'Approve payment card',
  waiting: 'Waiting for approval',
  card: 'Card',
  app: 'App',
  domain: 'Domain',
  timeLeft: '{time} left',
  expired: 'Approval expired',
  approve: 'Approve',
  deny: 'Deny',
};

export interface TaskApprovalProps {
  /** The pending approval, e.g. from `useTaskApproval`. Renders nothing when null/undefined. */
  approval?: PendingApproval | null;
  /** Called with the user's decision. The backend decides; this only forwards it. */
  onDecide: (decision: ApprovalDecision) => void;
  /** Disables both buttons (a decision is in flight). */
  isPending?: boolean;
  /** Which button shows the spinner while `isPending`. */
  decision?: ApprovalDecision;
  /** Error text, e.g. a failed decide call. */
  error?: string;
  /** Rendered next to the details on md+ and below them on small screens, e.g. `<DeviceStream />`. */
  device?: ReactNode;
  /** Override any user-visible string (i18n). */
  labels?: Partial<TaskApprovalLabels>;
  className?: string;
}

/** Re-renders every second with the current time. Display only. */
function useNowMs(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ApprovalFact({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="relative py-3 pl-16 pr-4">
      <dt className="text-xs text-muted-foreground">
        <span
          aria-hidden
          className="absolute left-4 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <Icon className="size-4" aria-hidden />
        </span>
        {label}
      </dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * Inline card showing a task's pending human approval with a countdown and
 * Approve/Deny buttons. Purely presentational: it renders what the API
 * returned and forwards the decision; the countdown is display only.
 *
 * ```tsx
 * const { approval, decide, isDeciding, decision, error } = useTaskApproval({ taskId, fetchApproval, decide: send });
 * <TaskApproval approval={approval} onDecide={decide} isPending={isDeciding} decision={decision} />
 * ```
 */
export function TaskApproval({
  approval,
  onDecide,
  isPending = false,
  decision,
  error,
  device,
  labels,
  className,
}: TaskApprovalProps) {
  const now = useNowMs();
  if (!approval) return null;

  const t = { ...DEFAULT_LABELS, ...labels };
  const card = approval.kind === 'payment_card' ? parsePaymentCardDetails(approval.details) : undefined;
  const remaining = remainingMs(approval.expiresAt, now);

  const details = card ? (
    <dl className="divide-y rounded-lg border">
      <ApprovalFact icon={CreditCard} label={t.card} value={card.card} />
      <ApprovalFact icon={AppWindow} label={t.app} value={card.targetPackage} />
      {card.targetHost && <ApprovalFact icon={Globe} label={t.domain} value={card.targetHost} />}
    </dl>
  ) : (
    <p className="text-sm text-muted-foreground">{t.waiting}</p>
  );

  return (
    <section
      aria-label={card ? t.paymentCardTitle : t.waiting}
      className={cn('flex w-full flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-6', className)}
    >
      <header className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">{card ? t.paymentCardTitle : t.waiting}</h3>
        <p
          role="timer"
          className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground tabular-nums"
        >
          <Clock className="size-3.5" aria-hidden />
          {remaining > 0 ? t.timeLeft.replace('{time}', formatRemaining(remaining)) : t.expired}
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:gap-6">
        <div className="flex min-w-0 flex-col gap-4">
          {details}
          {error && (
            <p role="alert" className="break-words text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="mt-auto grid grid-cols-2 gap-2">
            <Button onClick={() => onDecide('approve')} disabled={isPending}>
              {isPending && decision === 'approve' ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              {t.approve}
            </Button>
            <Button variant="outline" onClick={() => onDecide('deny')} disabled={isPending}>
              {isPending && decision === 'deny' ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
              {t.deny}
            </Button>
          </div>
        </div>
        {device && <div className="min-w-0 md:w-64">{device}</div>}
      </div>
    </section>
  );
}
