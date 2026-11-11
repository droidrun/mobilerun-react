'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, PendingApproval } from '../lib/task-approval';

export interface UseTaskApprovalOptions {
  taskId: string;
  /** Your backend: GET /tasks/{id} → pendingApproval (null when none or the task is not running). */
  fetchApproval: (taskId: string) => Promise<PendingApproval | null>;
  /** Your backend: POST /tasks/{id}/approvals/{approvalId} { decision }. Throw on non-2xx. */
  decide: (input: { taskId: string; approvalId: string; decision: ApprovalDecision }) => Promise<void>;
  /** Optional push source (e.g. SSE fed by your webhook handler). Call onChange when an approval event for this task arrives; return an unsubscribe. */
  subscribe?: (onChange: () => void) => () => void;
  /** Poll interval while enabled. Default 0 (off) when `subscribe` is given, else 3000. */
  pollIntervalMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

export interface UseTaskApprovalResult {
  approval: PendingApproval | null;
  /** True until the first fetch resolves. */
  isLoading: boolean;
  /** The last fetch or decide error, if any. */
  error?: unknown;
  decide: (decision: ApprovalDecision) => void;
  isDeciding: boolean;
  /** The in-flight or last decision. */
  decision?: ApprovalDecision;
  refetch: () => void;
}

/**
 * Loads a task's pending approval through your backend and sends the decision
 * back through it, so the API key never reaches the browser. Events (webhook →
 * SSE) only trigger a reload; the fetched approval is the source of truth.
 * Pair with `<TaskApproval />`:
 *
 * ```tsx
 * const { approval, decide, isDeciding, decision, error } = useTaskApproval({
 *   taskId,
 *   fetchApproval,
 *   decide: sendDecision,
 *   subscribe,
 * });
 * return <TaskApproval approval={approval} onDecide={decide} isPending={isDeciding} decision={decision} />;
 * ```
 */
export function useTaskApproval({
  taskId,
  fetchApproval,
  decide: sendDecision,
  subscribe,
  pollIntervalMs,
  enabled = true,
  onError,
}: UseTaskApprovalOptions): UseTaskApprovalResult {
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<unknown>(undefined);
  const [isDeciding, setIsDeciding] = useState(false);
  const [decision, setDecision] = useState<ApprovalDecision | undefined>(undefined);

  const fetchRef = useRef(fetchApproval);
  fetchRef.current = fetchApproval;
  const decideRef = useRef(sendDecision);
  decideRef.current = sendDecision;
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  // Guards against stale results after a taskId change or unmount.
  const generationRef = useRef(0);

  const hasSubscribe = !!subscribe;
  const interval = pollIntervalMs ?? (hasSubscribe ? 0 : 3000);

  const [fetchEpoch, setFetchEpoch] = useState(0);
  const refetch = useCallback(() => setFetchEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!enabled || !taskId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const generation = ++generationRef.current;

    const load = async () => {
      if (pollTimer) clearTimeout(pollTimer);
      try {
        const next = await fetchRef.current(taskId);
        if (cancelled || generation !== generationRef.current) return;
        setApproval(next);
        setError(undefined);
      } catch (err) {
        if (cancelled || generation !== generationRef.current) return;
        setError(err);
        onErrorRef.current?.(err);
      } finally {
        if (!cancelled && generation === generationRef.current) {
          setIsLoading(false);
          if (interval > 0) pollTimer = setTimeout(load, interval);
        }
      }
    };

    setIsLoading(true);
    void load();
    if (subscribeRef.current) {
      unsubscribe = subscribeRef.current(() => {
        if (!cancelled) void load();
      });
    }

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      unsubscribe?.();
    };
  }, [taskId, enabled, interval, hasSubscribe, fetchEpoch]);

  // A different task starts clean.
  useEffect(() => {
    setApproval(null);
    setError(undefined);
    setIsDeciding(false);
    setDecision(undefined);
  }, [taskId]);

  const decide = useCallback(
    (next: ApprovalDecision) => {
      const current = approvalRef.current;
      if (!current) return;
      const generation = generationRef.current;
      setDecision(next);
      setIsDeciding(true);
      void (async () => {
        try {
          await decideRef.current({ taskId, approvalId: current.approvalId, decision: next });
          if (generation === generationRef.current) setError(undefined);
        } catch (err) {
          if (generation !== generationRef.current) return;
          setError(err);
          onErrorRef.current?.(err);
        } finally {
          if (generation === generationRef.current) {
            setIsDeciding(false);
            setFetchEpoch((e) => e + 1);
          }
        }
      })();
    },
    [taskId],
  );

  return { approval, isLoading, error, decide, isDeciding, decision, refetch };
}
