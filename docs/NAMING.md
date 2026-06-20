# Naming Policy

The product is **WorkX**, unified across every surface — the Chrome extension,
the desktop app, and the server. There is a single brand and a single internal
codename.

| Context | Name |
|---------|------|
| User-facing product (all surfaces) | **WorkX** |
| Internal identifiers (lowercase codename) | `workx` |
| Tauri product / binary | `WorkX` |
| Bundle identifier | `com.airepublic.workx` |
| Rust crate | `workx` |

Earlier the codebase used three separate codenames — `applepi`/`pi`
(desktop/server) and `browserx` (extension). These have been fully renamed to
`workx`. The only legacy name deliberately retained is the **`applepi://` deep
link scheme**, kept as a registered fallback (see below).

## Agent types

The three runtime surfaces are distinguished by agent type:

| Agent type | Surface |
|-----------|---------|
| `workx` | Chrome extension |
| `workx-desktop` | Desktop (Tauri) runtime |
| `workx-server` | Headless server |

## Deep links

| Scheme | Status |
|--------|--------|
| `workx://` | **Canonical.** Registered on all platforms and used for every generated link (auth callback, scheduler, etc.). |
| `applepi://` | **Legacy fallback only.** Still registered and accepted by the handler so links issued before the rename keep working. Nothing generates it anymore. |

Both schemes are registered in `tauri.conf.json`, `Info.plist`, and the Linux
`.desktop` `MimeType`, and both are accepted by `is_app_deep_link` in
`tauri/src/main.rs`.

### External coordination note

The hosted-auth login flow now sends `redirect_url=workx://auth/callback`
(`src/config/runtimeUrls.ts`, `src/webfront/stores/userStore.ts`). The hosted
auth provider must allow the `workx://auth/callback` redirect URL, otherwise
login will fail. If the provider enforces an allow-list, add `workx://` (and
keep `applepi://` until all clients are updated) before shipping.

## Enforcement

`src/__tests__/naming-convention.test.ts` asserts the unified `workx` naming
across persistence keys, events, DOM attributes, agent types, product identity,
and the deep-link scheme registration.
