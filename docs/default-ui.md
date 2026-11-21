← [README](../README.md) · [Partner guide](https://docs.mobilerun.ai/partners)

# Components and styling

Drop a live, controllable cloud device (iOS/ Android) into any React app:

- **`<DeviceStream />`** — WebRTC video with touch, swipe and keyboard control, plus automatic reconnects with exponential backoff and a retry UI once attempts are exhausted.
- **`useDeviceStream()`** — resolves a device's stream URL and state from
  [`@mobilerun/sdk`](https://www.npmjs.com/package/@mobilerun/sdk), polling while it boots.
- **`<TaskApproval />`** + **`useTaskApproval()`** — show a task's pending human approval (e.g. "enter payment card X into app Y") with a countdown and Approve/Deny buttons. See [Task approvals](task-approvals.md).
- **`<NavigationBar />`**, **`<StreamStatusPill />`**, **`<RemoteControl />`** — the surrounding chrome and a lower-level escape hatch.
- **Prebuilt stylesheet** — no Tailwind setup required, themeable via CSS variables.
- **Typed** — ships its own `.d.ts`; React and the SDK are peer dependencies.

## Lower-level exports

- `Button` / `cn` — shared button and class-name utilities.
- `useWebRtcConnection` — lower-level WebRTC connection state.
- `useStreamReconnect` — bounded retries and reconnect state.
- `useDeviceGridSelfHeal` — coordinate stream recovery in a device grid.
- `useScrcpyInput` — send touch and keyboard input.
- scrcpy protocol helpers and constants — encode remote-control messages.

## Styling and theming

Import the prebuilt stylesheet once, anywhere:

```ts
import '@mobilerun/react/styles.css';
```

It bundles the design tokens, only the Tailwind utilities the components use, the animations, and the structural CSS. It does **not** include Tailwind's preflight/reset, so it won't touch your base styles — and you don't need Tailwind installed.

Retheme by setting the `--mr-*` variables on an ancestor or on the component root
(`.mobilerun-device-stream`, `.mobilerun-task-approval`, `.mobilerun-navigation-bar`). The package
defines no unprefixed variable globally, so it cannot clash with your own `--background`. Add a
`.dark` ancestor (or class on the component root) for the bundled dark palette:

```css
.mobilerun-device-stream {
  --mr-primary: oklch(0.55 0.18 268);
  --mr-background: oklch(0.985 0.004 85);
}
```

Available tokens: `--mr-background`, `--mr-foreground`, `--mr-card`, `--mr-card-foreground`,
`--mr-muted`, `--mr-muted-foreground`, `--mr-border`, `--mr-ring`, `--mr-primary`,
`--mr-primary-foreground`, `--mr-accent`, `--mr-accent-foreground`, `--mr-destructive`.

The old unprefixed names (`--background`, `--card`, ...) are still read as a fallback for one more
minor release, so themes written for 0.3 keep working; move them to `--mr-*`. User-visible texts are
set with the `labels` prop, see [Stream keys](stream-keys.md#labels).
