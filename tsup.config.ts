import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  // React and the SDK are peer deps; never bundle them. Everything else in
  // `dependencies` is also kept external so consumers dedupe via their own
  // node_modules.
  external: ['react', 'react-dom', '@mobilerun/sdk'],
  // The component CSS imports (remote-control.css, device-stream.css) are
  // collected by tsup into dist/index.css. The full themed bundle is built
  // separately via Tailwind into dist/styles.css.
  injectStyle: false,
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
