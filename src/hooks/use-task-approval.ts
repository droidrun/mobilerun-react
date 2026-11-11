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
  subscribe?: (taskId: string, onChange: () => void) => () => void;
  /** Poll interval while enabled. Default 0 (off) when `subscribe` is given, else 3000. */
  pollIntervalMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

export interface UseTaskApprovalResult {
  approval: PendingApproval | null;
  /** True until the first fetch resolves. */
  isLoading: boolean;
  /**
   * The last decide error (cleared by the next decide attempt or a task change),
   * else the last fetch error (cleared by the next successful fetch).
   */
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
 * return <TaskApproval approval={approval} onDecide={decide} isPending={isDeciding} decision={decision} error={error} />;
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
  const [fetchError, setFetchError] = useState<unknown>(undefined);
  const [decideError, setDecideError] = useState<unknown>(undefined);
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
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const decidingRef = useRef(false);
  // Request sequence: an older overlapping fetch never overwrites a newer one.
  const seqRef = useRef(0);
  // The running effect's `load`, so refetch never re-subscribes.
  const reloadRef = useRef<() => void>(() => {});

  const hasSubscribe = !!subscribe;
  const interval = pollIntervalMs ?? (hasSubscribe ? 0 : 3000);

  useEffect(() => {
    // A different task starts clean.
    setApproval(null);
    setFetchError(undefined);
    setDecideError(undefined);
    setIsDeciding(false);
    setDecision(undefined);
    decidingRef.current = false;

    if (!enabled || !taskId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const load = async () => {
      if (pollTimer) clearTimeout(pollTimer);
      const seq = ++seqRef.current;
      try {
        const next = await fetchRef.current(taskId);
        if (cancelled || seq !== seqRef.current) return;
        setApproval(next);
        setFetchError(undefined);
      } catch (err) {
        if (cancelled || seq !== seqRef.current) return;
        setFetchError(err);
        onErrorRef.current?.(err);
      } finally {
        if (!cancelled && seq === seqRef.current) {
          setIsLoading(false);
          if (interval > 0) pollTimer = setTimeout(load, interval);
        }
      }
    };

    reloadRef.current = () => void load();
    setIsLoading(true);
    void load();
    unsubscribe = subscribeRef.current?.(taskId, () => {
      if (!cancelled) void load();
    });

    return () => {
      cancelled = true;
      reloadRef.current = () => {};
      if (pollTimer) clearTimeout(pollTimer);
      unsubscribe?.();
    };
  }, [taskId, enabled, interval, hasSubscribe]);

  const refetch = useCallback(() => reloadRef.current(), []);

  const decide = useCallback(
    (next: ApprovalDecision) => {
      const current = approvalRef.current;
      if (!current || decidingRef.current) return;
      decidingRef.current = true;
      setDecision(next);
      setDecideError(undefined);
      setIsDeciding(true);
      void (async () => {
        try {
          await decideRef.current({ taskId, approvalId: current.approvalId, decision: next });
        } catch (err) {
          if (taskIdRef.current === taskId) {
            setDecideError(err);
            onErrorRef.current?.(err);
          }
        } finally {
          if (taskIdRef.current === taskId) {
            decidingRef.current = false;
            setIsDeciding(false);
            reloadRef.current();
          }
        }
      })();
    },
    [taskId],
  );

  return { approval, isLoading, error: decideError ?? fetchError, decide, isDeciding, decision, refetch };
}
