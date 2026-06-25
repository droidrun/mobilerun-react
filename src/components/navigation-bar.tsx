'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { Button } from './ui/button';
import { ChevronLeft, Home, LayoutGrid } from 'lucide-react';
import { cn } from '../lib/cn';

interface NavigationBarProps {
  onAction: (keycode: 'BACK' | 'HOME' | 'RECENT') => void;
  /** Extra classes for the bar container (e.g. to restyle the top border). */
  className?: string;
}

export function NavigationBar({ onAction, className }: NavigationBarProps) {
  return (
    <div className={cn('flex flex-row bg-background border-t border-border shrink-0 h-10', className)}>
      <Button
        variant="ghost"
        className="flex-1 rounded-none h-full hover:bg-muted"
        onClick={() => onAction('BACK')}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        className="flex-1 rounded-none h-full hover:bg-muted"
        onClick={() => onAction('HOME')}
      >
        <Home className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        className="flex-1 rounded-none h-full hover:bg-muted"
        onClick={() => onAction('RECENT')}
      >
        <LayoutGrid className="h-4 w-4" />
      </Button>
    </div>
  );
}
