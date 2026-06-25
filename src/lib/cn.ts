// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with Tailwind-aware conflict resolution. Vendored so this
 * package has no dependency on the host app's util barrel.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
