'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

interface StreamStatusPillProps {
  label: string;
  className?: string;
}

/**
 * Corner pill shown over the stream while it isn't connected yet. Self-contained
 * (a small spinner + label) so the package doesn't depend on the host app's
 * device-loader component.
 */
export function StreamStatusPill({ label, className }: StreamStatusPillProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-4 left-4 z-10 animate-in fade-in slide-in-from-bottom-6 zoom-in-95 duration-500 ease-out',
        className,
      )}
    >
      <div className="inline-flex items-center gap-2.5 rounded-full border border-border bg-card/80 px-3 py-1.5 shadow-md backdrop-blur-md">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}
