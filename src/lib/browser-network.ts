// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

/** Unknown browser connectivity is optimistic; this is only a scheduling hint. */
export function browserReportsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
