/**
 * Lightweight content script used by WorkX.
 *
 * CDP MIGRATION:
 * - DOM tool: Migrated to CDP (003-cdp-dom-refactor)
 * - Visual effects: Triggered via CDP Runtime.evaluate (CSP-safe, synchronous)
 *
 * This content script mounts the visual effect controller.
 * Visual effects are triggered by CDP injecting JavaScript that dispatches custom events.
 */

// VISUAL EFFECTS v4.0 - CDP-triggered
import { mount, unmount } from 'svelte';
import VisualEffectController from './ui_effect/VisualEffectController.svelte';

// Unique instance ID for debugging
const INSTANCE_ID = Math.random().toString(36).substring(7);
console.log(`[WorkX] Content script loading - Instance ID: ${INSTANCE_ID}, Frame: ${window.self === window.top ? 'MAIN' : 'IFRAME'}, URL: ${window.location.href}`);

let visualEffectController: any = null;
let visualEffectShadowHost: HTMLElement | null = null;

interface PageContext {
	url: string;
	title: string;
	domain: string;
	protocol: string;
	pathname: string;
	search: string;
	hash: string;
	viewport: {
		width: number;
		height: number;
		scrollX: number;
		scrollY: number;
	};
	metadata: Record<string, string>;
}

function initialize(): void {
	console.log(`[WorkX] Initializing Instance ${INSTANCE_ID} - Frame: ${window.self === window.top ? 'MAIN' : 'IFRAME'}`);

	// Double-check we're in the main frame (shouldn't happen with all_frames: false, but defensive)
	if (window.self !== window.top) {
		console.warn(`[WorkX] Instance ${INSTANCE_ID} - Running in IFRAME despite all_frames: false! Aborting initialization.`);
		return;
	}

	// Check for existing initialization marker
	if ((window as any).__workx_content_script_loaded__) {
		console.error(`[WorkX] Instance ${INSTANCE_ID} - DUPLICATE INITIALIZATION DETECTED! Another instance already loaded.`);
		console.error(`[WorkX] Existing instance ID: ${(window as any).__workx_instance_id__}`);
		return;
	}

	// Mark as initialized
	(window as any).__workx_content_script_loaded__ = true;
	(window as any).__workx_instance_id__ = INSTANCE_ID;

	console.log(`[WorkX] Instance ${INSTANCE_ID} - Content script initialized (main frame only)`);

	// Setup lazy initialization for visual effects
	// Visual effects will only initialize when DomService first needs them
	setupVisualEffectsListener();
}

/**
 * Setup lazy initialization listener for visual effects
 * Visual effects only initialize when DomService first needs them (saves memory/CPU on non-working tabs)
 */
function setupVisualEffectsListener(): void {
	document.addEventListener('workx:init-visual-effects', () => {
		if (!visualEffectController) {
			console.log(`[WorkX] Instance ${INSTANCE_ID} - Lazy initializing visual effects...`);
			initializeVisualEffects();
			(window as any).__workx_visual_effects_initialized__ = true;
		}
	}, { once: true }); // Only listen once
}

/**
 * Initialize Visual Effect Controller
 * Mounts Svelte component in Shadow DOM for style isolation
 * Visual effects are triggered by CDP via Runtime.evaluate (not chrome.runtime.onMessage)
 */
function initializeVisualEffects(): void {
	try {
		console.log(`[WorkX] Instance ${INSTANCE_ID} - Initializing visual effects...`);

		// Check if visual effects already exist in DOM (from another instance)
		const existingHosts = document.querySelectorAll('#workx-visual-effects-host');
		if (existingHosts.length > 0) {
			console.error(`[WorkX] Instance ${INSTANCE_ID} - DUPLICATE VISUAL EFFECTS DETECTED! Found ${existingHosts.length} existing host(s)`);
			existingHosts.forEach((host, idx) => {
				console.error(`[WorkX] Existing host ${idx}:`, host);
			});

			// Clean up duplicates
			existingHosts.forEach((host, idx) => {
				if (idx < existingHosts.length - 1) { // Keep the last one
					console.log(`[WorkX] Removing duplicate host ${idx}`);
					host.remove();
				}
			});

			visualEffectShadowHost = existingHosts[existingHosts.length - 1] as HTMLElement;
			console.log(`[WorkX] Instance ${INSTANCE_ID} - Reusing existing visual effects host`);
			return;
		}

		// Create shadow host element
		visualEffectShadowHost = document.createElement('div');
		visualEffectShadowHost.id = 'workx-visual-effects-host';
		visualEffectShadowHost.dataset.instanceId = INSTANCE_ID;
		visualEffectShadowHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';

		// Attach shadow DOM (closed mode for isolation)
		const shadowRoot = visualEffectShadowHost.attachShadow({ mode: 'closed' });

		// Mount Visual Effect Controller Svelte component
		visualEffectController = mount(VisualEffectController, {
			target: shadowRoot,
		});

		// Append to document body
		document.body.appendChild(visualEffectShadowHost);

		console.log(`[WorkX] Instance ${INSTANCE_ID} - Visual effects initialized successfully`);

		// Log all cursors in the DOM for debugging
		setTimeout(() => {
			const cursors = document.querySelectorAll('[data-testid="cursor-animator"]');
			console.log(`[WorkX] Instance ${INSTANCE_ID} - Cursor count in DOM: ${cursors.length}`);
			if (cursors.length > 1) {
				console.error(`[WorkX] Instance ${INSTANCE_ID} - MULTIPLE CURSORS DETECTED!`);
			}
		}, 1000);
	} catch (error) {
		// Graceful degradation - visual effects failure never blocks content script
		console.error(`[WorkX] Instance ${INSTANCE_ID} - Failed to initialize visual effects:`, error);
	}
}

function getPageContext(): PageContext {
	const location = window.location;
	const metadata: Record<string, string> = {};

	document.querySelectorAll('meta').forEach(meta => {
		const name = meta.getAttribute('name') || meta.getAttribute('property');
		const content = meta.getAttribute('content');
		if (name && content) {
			metadata[name] = content;
		}
	});

	return {
		url: location.href,
		title: document.title,
		domain: location.hostname,
		protocol: location.protocol,
		pathname: location.pathname,
		search: location.search,
		hash: location.hash,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			scrollX: window.scrollX,
			scrollY: window.scrollY
		},
		metadata
	};
}

window.addEventListener('pagehide', () => {
	console.log(`[WorkX] Instance ${INSTANCE_ID} - Page hiding, cleaning up...`);

	// Clean up visual effects
	if (visualEffectController) {
		unmount(visualEffectController);
		visualEffectController = null;
		console.log(`[WorkX] Instance ${INSTANCE_ID} - Visual effects destroyed`);
	}
	if (visualEffectShadowHost && visualEffectShadowHost.parentNode) {
		visualEffectShadowHost.parentNode.removeChild(visualEffectShadowHost);
		visualEffectShadowHost = null;
	}

	// Clear initialization flags
	delete (window as any).__workx_content_script_loaded__;
	delete (window as any).__workx_instance_id__;
	console.log(`[WorkX] Instance ${INSTANCE_ID} - Cleanup complete`);
});

initialize();

export { getPageContext };

// Diagnostic utility - accessible from browser console
(window as any).workxDebug = {
	getInstanceInfo: () => {
		const info = {
			instanceId: INSTANCE_ID,
			isMainFrame: window.self === window.top,
			url: window.location.href,
			initialized: !!(window as any).__workx_content_script_loaded__,
			storedInstanceId: (window as any).__workx_instance_id__,
			visualEffectController: !!visualEffectController,
			shadowHost: !!visualEffectShadowHost,
			hostsInDOM: document.querySelectorAll('#workx-visual-effects-host').length,
			cursorsInDOM: document.querySelectorAll('[data-testid="cursor-animator"]').length,
			overlaysInDOM: document.querySelectorAll('[data-testid="visual-effect-overlay"]').length,
		};

		console.log('[WorkX Debug Info]', info);

		// List all hosts
		const hosts = document.querySelectorAll('#workx-visual-effects-host');
		hosts.forEach((host, idx) => {
			console.log(`Host ${idx}:`, {
				element: host,
				instanceId: (host as HTMLElement).dataset.instanceId,
			});
		});

		return info;
	},

	cleanupDuplicates: () => {
		console.log('[WorkX] Cleaning up duplicate visual effects...');
		const hosts = document.querySelectorAll('#workx-visual-effects-host');
		console.log(`Found ${hosts.length} host(s)`);

		if (hosts.length > 1) {
			hosts.forEach((host, idx) => {
				if (idx < hosts.length - 1) {
					console.log(`Removing host ${idx}`);
					host.remove();
				}
			});
			console.log('Cleanup complete - kept last host');
		} else {
			console.log('No duplicates found');
		}
	}
};

console.log(`[WorkX] Instance ${INSTANCE_ID} - Debug utility available: window.workxDebug.getInstanceInfo()`);
console.log(`[WorkX] Instance ${INSTANCE_ID} - To cleanup duplicates: window.workxDebug.cleanupDuplicates()`);

