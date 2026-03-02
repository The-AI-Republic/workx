# Data Model: CSS Token Mapping

**Feature**: 001-unify-css-tailwind
**Note**: This feature has no traditional data model. This document defines the CSS design token mapping that replaces the existing CSS custom property system.

## Entity: Tailwind Theme Tokens

The `@theme` block in `src/webfront/styles.css` defines all design tokens. These replace both the `tailwind.config.mjs` theme extensions and `sidepanel.css` CSS custom properties.

### Terminal Colors (Fixed — no dark variants)

| Token | Value | Tailwind Class Example |
|-------|-------|----------------------|
| `--color-term-bg` | `#000000` | `bg-term-bg` |
| `--color-term-green` | `#00ff00` | `text-term-green` |
| `--color-term-yellow` | `#ffff00` | `text-term-yellow` |
| `--color-term-red` | `#ff0000` | `text-term-red` |
| `--color-term-bright-green` | `#33ff00` | `text-term-bright-green` |
| `--color-term-dim-green` | `#00cc00` | `text-term-dim-green` |
| `--color-term-blue` | `#60a5fa` | `text-term-blue` |

| Token | Value | Tailwind Class Example |
|-------|-------|----------------------|
| `--font-terminal` | `Menlo, Monaco, Consolas, ...` | `font-terminal` |

### BrowserX Semantic Colors (Light + Dark pairs)

| Token (Light) | Value | Token (Dark) | Value |
|--------------|-------|-------------|-------|
| `--color-bx-primary` | `#4f46e5` | `--color-bx-primary-dark` | `#6366f1` |
| `--color-bx-secondary` | `#6366f1` | `--color-bx-secondary-dark` | `#818cf8` |
| `--color-bx-bg` | `#ffffff` | `--color-bx-bg-dark` | `#111827` |
| `--color-bx-surface` | `#f9fafb` | `--color-bx-surface-dark` | `#1f2937` |
| `--color-bx-text` | `#111827` | `--color-bx-text-dark` | `#f9fafb` |
| `--color-bx-text-secondary` | `#6b7280` | `--color-bx-text-secondary-dark` | `#9ca3af` |
| `--color-bx-border` | `#e5e7eb` | `--color-bx-border-dark` | `#374151` |
| `--color-bx-error` | `#ef4444` | `--color-bx-error-dark` | `#f87171` |
| `--color-bx-success` | `#10b981` | `--color-bx-success-dark` | `#34d399` |
| `--color-bx-warning` | `#f59e0b` | `--color-bx-warning-dark` | `#fbbf24` |

**Usage**: `text-bx-text dark:text-bx-text-dark`, `bg-bx-bg dark:bg-bx-bg-dark`

### ChatGPT Theme Colors (Light + Dark pairs)

| Token (Light) | Value | Token (Dark) | Value |
|--------------|-------|-------------|-------|
| `--color-chat-bg` | `#ffffff` | `--color-chat-bg-dark` | `#212121` |
| `--color-chat-surface` | `#f7f7f8` | `--color-chat-surface-dark` | `#2f2f2f` |
| `--color-chat-header` | `#ffffff` | `--color-chat-header-dark` | `#212121` |
| `--color-chat-text` | `#0d0d0d` | `--color-chat-text-dark` | `#ececec` |
| `--color-chat-text-secondary` | `#6e6e80` | `--color-chat-text-secondary-dark` | `#b4b4b4` |
| `--color-chat-text-muted` | `#8e8ea0` | `--color-chat-text-muted-dark` | `#8e8ea0` |
| `--color-chat-border` | `#e5e5e5` | `--color-chat-border-dark` | `#3e3e3e` |
| `--color-chat-input` | `#f4f4f4` | `--color-chat-input-dark` | `#2f2f2f` |
| `--color-chat-input-border` | `#e5e5e5` | `--color-chat-input-border-dark` | `#3e3e3e` |
| `--color-chat-input-focus` | `#60a5fa` | `--color-chat-input-focus-dark` | `#60a5fa` |
| `--color-chat-agent-bg` | `#f7f7f8` | `--color-chat-agent-bg-dark` | `#2f2f2f` |
| `--color-chat-code-bg` | `#f7f7f8` | `--color-chat-code-bg-dark` | `#2f2f2f` |
| `--color-chat-primary` | `#60a5fa` | `--color-chat-primary-dark` | `#60a5fa` |
| `--color-chat-error` | `#ef4444` | `--color-chat-error-dark` | `#f87171` |
| `--color-chat-card` | `#ffffff` | `--color-chat-card-dark` | `#2f2f2f` |
| `--color-chat-card-border` | `#e5e5e5` | `--color-chat-card-border-dark` | `#3e3e3e` |
| `--color-chat-card-hover` | `#f7f7f8` | `--color-chat-card-hover-dark` | `#3a3a3a` |
| `--color-chat-badge` | `#f4f4f4` | `--color-chat-badge-dark` | `#3e3e3e` |
| `--color-chat-button` | `#10a37f` | `--color-chat-button-dark` | `#10a37f` |
| `--color-chat-button-hover` | `#ececec` | `--color-chat-button-hover-dark` | `#3e3e3e` |
| `--color-chat-tooltip` | `#0d0d0d` | `--color-chat-tooltip-dark` | `#0d0d0d` |
| `--color-chat-tooltip-text` | `#ffffff` | `--color-chat-tooltip-text-dark` | `#ffffff` |
| `--color-chat-send` | `#0d0d0d` | `--color-chat-send-dark` | `#ececec` |
| `--color-chat-send-text` | `#ffffff` | `--color-chat-send-text-dark` | `#212121` |
| `--color-chat-send-hover` | `#2d2d2d` | `--color-chat-send-hover-dark` | `#d9d9d9` |
| `--color-chat-send-disabled` | `#e5e5e5` | `--color-chat-send-disabled-dark` | `#3e3e3e` |
| `--color-chat-stop` | `#ef4444` | `--color-chat-stop-dark` | `#ef4444` |
| `--color-chat-stop-hover` | `#dc2626` | `--color-chat-stop-hover-dark` | `#dc2626` |
| `--color-chat-status-running` | `#60a5fa` | `--color-chat-status-running-dark` | `#60a5fa` |
| `--color-chat-status-success` | `#10b981` | `--color-chat-status-success-dark` | `#34d399` |
| `--color-chat-status-error` | `#ef4444` | `--color-chat-status-error-dark` | `#f87171` |
| `--color-chat-status-warning` | `#f59e0b` | `--color-chat-status-warning-dark` | `#fbbf24` |
| `--color-chat-avatar-user` | `#5436da` | `--color-chat-avatar-user-dark` | `#7c3aed` |
| `--color-chat-avatar-agent` | `#60a5fa` | `--color-chat-avatar-agent-dark` | `#60a5fa` |

### Font Family

| Token | Value |
|-------|-------|
| `--font-terminal` | `Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace` |
| `--font-chat` | `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif` |

## State Transitions

**Theme state**: `terminal` ↔ `chatgpt` (toggled via `uiTheme` Svelte store, persisted to AgentConfig)

**Dark mode state**: `light` ↔ `dark` (OS preference via `@media (prefers-color-scheme: dark)`, detected by Tailwind `dark:` variant)

**Interaction matrix**:

| Theme | OS Light Mode | OS Dark Mode |
|-------|--------------|-------------|
| `terminal` | Fixed terminal palette | Fixed terminal palette (no change) |
| `chatgpt` | Light color tokens | Dark color tokens (via `dark:` classes) |

## Validation Rules

- All `--color-*-dark` tokens must have a corresponding light token
- Terminal tokens have no `-dark` suffix (single value only)
- Every color pair must pass WCAG AA contrast ratio (4.5:1 for text, 3:1 for large text) in its respective mode
