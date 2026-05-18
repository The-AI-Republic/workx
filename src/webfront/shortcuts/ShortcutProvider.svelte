<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    keyboardEventToKeystroke,
    resolveShortcut,
    shouldResolveInAppShortcut,
  } from '@/core/shortcuts';
  import { AgentConfig } from '@/config/AgentConfig';
  import { getActiveShortcutContexts, invokeShortcutAction } from './useShortcut';
  import { reloadShortcutStore, shortcutStore } from './shortcutStore';

  let {
    children,
  }: {
    children?: import('svelte').Snippet;
  } = $props();

  let unsubscribeConfig: (() => void) | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let bindings = $state($shortcutStore.bindings);
  let platform = $state($shortcutStore.platform);

  function handleKeydown(event: KeyboardEvent) {
    const activeContexts = getActiveShortcutContexts();
    if (!shouldResolveInAppShortcut(event, activeContexts)) return;

    const key = keyboardEventToKeystroke(event);
    if (!key) return;

    const result = resolveShortcut(key, activeContexts, bindings);
    if (result.type === 'none') return;

    if (result.type === 'unbound') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const consumed = invokeShortcutAction(result.action, result.binding.context, event);
    if (consumed) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  onMount(() => {
    void reloadShortcutStore();
    unsubscribeStore = shortcutStore.subscribe((state) => {
      bindings = state.bindings;
      platform = state.platform;
    });

    window.addEventListener('keydown', handleKeydown, { capture: true });

    AgentConfig.getInstance().then((config) => {
      const handler = (event: { section?: string }) => {
        if (!event.section || event.section === 'preferences' || event.section === 'policy') {
          void reloadShortcutStore();
        }
      };
      config.on('config-changed', handler as any);
      unsubscribeConfig = () => config.off('config-changed', handler as any);
    }).catch(() => {});
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown, { capture: true });
    unsubscribeStore?.();
    unsubscribeConfig?.();
  });
</script>

{@render children?.()}
