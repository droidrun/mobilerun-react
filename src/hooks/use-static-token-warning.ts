'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';

/** One console warning per mount while a deprecated static stream key is in use. */
export function useStaticTokenWarning(usingStaticToken: boolean) {
  const warnedRef = useRef(false);
  useEffect(() => {
    if (!usingStaticToken || warnedRef.current) return;
    warnedRef.current = true;
    // eslint-disable-next-line no-console -- one-time deprecation notice
    console.warn(
      '[@mobilerun/react] DeviceStream `streamToken` is deprecated: a stream key is single-use and cannot reconnect. Pass `tokenProvider` to get a fresh key for every connection.',
    );
  }, [usingStaticToken]);
}
