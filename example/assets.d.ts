// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

// Bun's browser bundler loads these assets for the example UI.
declare module '*.css';
declare module '*.png' {
  const url: string;
  export default url;
}
