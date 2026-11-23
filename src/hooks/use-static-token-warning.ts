'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';

/** One console warning per mount while a device token (legacy) is in use. */
export function useStaticTokenWarning(usingStaticToken: boolean) {
  const warnedRef = useRef(false);
  useEffect(() => {
    if (!usingStaticToken || warnedRef.current) return;
    warnedRef.current = true;
    // eslint-disable-next-line no-console -- one-time deprecation notice
    console.warn(
      '[@mobilerun/react] DeviceStream `streamToken` is deprecated (device token (legacy)). Pass `tokenProvider` to get a fresh stream token for every connection; a single-use stream token passed statically cannot reconnect.',
    );
  }, [usingStaticToken]);
}
