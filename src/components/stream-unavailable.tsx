'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { RotateCw, WifiOff } from 'lucide-react';
import type { DeviceStreamLabels } from '../lib/stream-error';
import { Button } from './ui/button';

interface StreamUnavailableProps {
  labels: Pick<DeviceStreamLabels, 'unavailable' | 'retry'>;
  onRetry: () => void;
}

/** Shown once the reconnect budget is spent. The button text sets its own color so it stays readable on dark hosts. */
export function StreamUnavailable({ labels, onRetry }: StreamUnavailableProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <WifiOff className="h-10 w-10 opacity-50" />
      <span className="text-xs font-medium">{labels.unavailable}</span>
      <Button variant="outline" className="text-foreground" onClick={onRetry}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" />
        {labels.retry}
      </Button>
    </div>
  );
}
