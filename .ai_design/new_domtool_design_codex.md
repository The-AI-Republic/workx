## Executive Summary
BrowserX currently ships a DOM tooling pipeline optimized for extracting actionable elements (`captureInteractionContent`). The output is control-centric and omits hierarchical, visual, and textual context that large language models require for reliable agentic behaviour. This document proposes a ground-up redesign centred on a `DomTool` class that builds an LLM-friendly virtual DOM snapshot (`VirtualNode` graph), keeps a reversible mapping to real DOM nodes, and executes page interactions directly from snapshot identifiers. The design draws on best practices from Chrome DevTools, WebDriver BiDi, Playwright’s accessibility tree, and academic projects such as ReAct-Web and BrowserGym.

## Problem Statement
- LLMs see a minimal JSON payload that lists controls, headings, and regions. They cannot reason about the layout, relative ordering, or surrounding text.
- Actions are routed through CSS selectors generated at capture time. When the DOM mutates (client-side rerenders, hydration), selectors go stale and actions fail.
- Visible vs. invisible filtering is inconsistent; we can leak hidden elements and waste tokens on irrelevant markup.
- Iframe and Shadow DOM contents are not unified with the main payload, leading to automation blind spots.
- The tool lacks telemetry, freshness, and retry strategies, making it hard to audit or recover from stale snapshots.

## Requirements

### Functional
1. Build a `VirtualNode` tree that reflects the visible DOM, preserving parent-child relationships, sibling order, and actionable metadata.
2. Support first-level iframes and Shadow DOM hosts and expose them in the serialized payload.
3. Provide bidirectional mapping between `VirtualNode.node_id` and the real `Node` for follow-up actions.
4. Surface methods on `DomTool` to click, type, and synthesize key presses given a virtual node ID.
5. Ensure the payload aligns with the provided schema (`page.context`, `page.body`, optional `iframe`/`shadowDom` arrays) and is optimized for LLM consumption.

### Non-Functional
1. Snapshot creation must finish <75 ms on mid-range hardware for typical pages (≤800 visible nodes) to keep interactions responsive.
2. Serialized payload size should remain under 50 KB or ~4,000 tokens; large DOMs must be summarized or truncated deterministically.
3. Node IDs should be stable across minor DOM mutations (e.g., style changes) and deterministic across repeated snapshot calls.
4. Respect privacy: avoid collecting input values for password fields or secure contexts unless explicit flags allow it.
5. Gracefully handle restricted contexts (cross-origin iframes, closed shadow roots) and report limitations to the LLM.

## Research & Industry Survey

| Source | Key Takeaways | Applicability |
| --- | --- | --- |
| **Chrome DevTools `DOMSnapshot` protocol** | Offers flattened document snapshots with layout information, text boxes, and string tables. Uses stable node IDs derived from tree order. | We can mirror their approach for ID generation (preorder index + attributes) and optionally collect bounding boxes. |
| **WebDriver BiDi `dom.getDocument` + `dom.describeNode`** | Returns a tree of remote references that include node type, local name, and computed accessibility. Visibility is determined by `isConnected` + layout checks. | Reinforces the need to carry accessibility role/name in our `VirtualNode` and reuse existing accessibility utilities. |
| **Playwright Accessibility Tree** | Provides `role`, `name`, `value`, `checked`, `level`, etc., while filtering hidden nodes using computed styles and `hidden="true"`. | Suggest extending `VirtualNode` with `actionable` heuristics similar to Playwright’s `isActionable` used for auto-waiting. |
| **Gmail / Slack DOM automation postmortems** (internal + public case studies) | Highly dynamic SPAs mutate classes/IDs frequently. Stable DOM paths plus structural hashing outperform CSS selectors. | Motivates deriving `node_id` from structural path segments + attribute hash. |
| **ReAct-Web / BrowserGym papers** | LLMs perform better when given hierarchical JSON with natural language summaries per node, rather than raw HTML. Token cost is managed via aggressive visibility pruning and summarization of repeated patterns. | Validates hierarchical JSON output and motivates adding summarization for long repeating children lists. |
| **Microsoft WebPilot & AutoGPT Browser** | Use filtered DOM snapshots, store reverse lookup maps, and revalidate elements before actions. Emphasize viewport awareness when choosing targets. | Encourages implementing a “verify before act” pipeline alongside `DomSnapshot` freshness checks. |

## Proposed Architecture

### Core Data Types
```ts
interface VirtualNode {
  node_id: string;
  tag: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  value?: string;
  visible: boolean;
  actionable?: boolean;
  children?: VirtualNode[];
  iframe?: VirtualNode[];
  shadowDom?: VirtualNode[];
}
```

**Node ID Strategy**
- Build a path signature: `tag[index|roleHint|idHint]` concatenated for ancestors.
- Hash the signature plus stable attributes (`id`, `aria-label`, `role`, `type`) using a lightweight hash (e.g., murmurhash3) to form `node_id` (`nv_<hash>`).
- Maintain `WeakMap<Node, string>` for caching; fallback to incremental counter when hashing fails.
- Ensure uniqueness by checking existing map; append collision suffix if needed.

**Visibility Algorithm**
1. `node.isConnected` && `document.contains(node)`.
2. Computed styles: `display !== 'none'`, `visibility !== 'hidden'`, `opacity > 0.05`.
3. Geometry: `getBoundingClientRect()` width/height > 1px; intersection ratio with viewport > 0 using `IntersectionObserver` fallback.
4. Clipping: ensure ancestors do not fully clip the element (`overflow: hidden` + zero rect).
5. For text nodes: rely on parent element’s visibility.

**Actionability Detection**
- Native interactive tags (`button`, `a[href]`, `input`, `select`, `textarea`).
- Role-based (`role="button"`, `role="menuitem"`, etc.) via `roleDetector`.
- `tabIndex >= 0` or `contentEditable === true`.
- Presence of event handler attributes (`onclick`, etc.) or pointer cursor; combine heuristics and avoid false positives by checking computed `pointer-events`.

### DomSnapshot Class
Responsibilities:
- `virtualDom: VirtualNode` representing `<body>`, plus arrays for `iframe` and `shadowDom` nodes.
- `takenAt: number` (timestamp).
- `nodeMap: Map<string, Element | Text>` for forward lookup.
- `reverseMap: WeakMap<Node, string>` for ID reuse.
- `metadata`: counts, truncation flags, unsupported nodes list.

Construction Flow (pseudo):
```ts
const buildSnapshot = (doc: Document): DomSnapshot => {
  const context = extractContext(doc);
  const state = new BuilderState();
  const bodyNode = traverseElement(doc.body, state, 0);
  const iframeNodes = state.iframes;
  const shadowNodes = state.shadowRoots;
  return new DomSnapshot({ context, virtualDom: bodyNode, iframe: iframeNodes, shadowDom: shadowNodes, state });
};
```

Traversal uses iterative DFS to avoid stack overflow. `BuilderState` tracks node limits (`MAX_NODES = 1500`), truncation, and node maps. If the limit is reached, we append a synthetic node: `{ tag: 'summary', text: 'Truncated after N nodes', visible: true }`.

### Serialization Format
```ts
interface PageSerialized {
  page: {
    context: {
      url: string;
      title: string;
      domain: string;
      viewport: { width: number; height: number; };
    };
    body: VirtualNode;
    iframe?: VirtualNode[];
    shadowDom?: VirtualNode[];
    meta?: {
      truncated: boolean;
      totalNodes: number;
      version: string;
    };
  };
}
```
- Provide `meta.version` for schema evolution (e.g., `domtool.v1`).
- For inaccessible frames, include placeholder node `{ tag: 'iframe', node_id: 'nv_iframe_<hash>', visible: false, text: 'Cross-origin iframe (blocked)' }`.
- Optionally attach `layout` metadata (bounding boxes, z-index) when `includeLayout` flag is passed; default off.

### DomTool Class (`src/content/DomTool.ts`)
Members:
- `private domSnapshot: DomSnapshot | null = null;`
- `private readonly snapshotTTL = 2000;` (ms)
- `private readonly maxRetries = 1;`
- `private readonly metricsCollector` (pluggable).

Methods:
- `async getSnapshot({ force }: { force?: boolean } = {})`: refresh when null, stale, or forced.
- `async get_serialized_dom(options?: SerializeOptions): Promise<PageSerialized>`; ensures snapshot freshness, optionally toggles layout data.
- `async click(nodeId: string): Promise<ActionResult>`:
  - `resolveNode(nodeId)`; if missing, refresh and retry.
  - `ensureInteractable(element)`; throw descriptive error with remediation suggestions.
  - convert to `HTMLElement`, call `prepareForInteraction` (scroll, focus), dispatch canonical pointer + mouse sequence with `PointerEvent`.
- `async type(nodeId: string, text: string, opts: { replace?: boolean } = {})`:
  - focus target (`element.focus({ preventScroll: true })`).
  - if `replace`, use `setSelectionRange(0, value.length)` then `document.execCommand('insertText', false, text)` fallback to `element.value = text`.
  - dispatch `input` and `change`.
- `async keypress(key: string, options?: KeyboardEventInit)`:
  - Determine target: `document.activeElement` or resolved element.
  - Use `new KeyboardEvent('keydown', { key, ...options })`, dispatch keydown, keypress (if printable), keyup.
  - For navigation keys (Arrow, Tab), optionally rely on `document.activeElement`.
- Utility: `private refreshIfDetached(nodeId, node)` to handle DOM churn.
- Potential future extension: `hover`, `selectOption`, `dragAndDrop`.

### Snapshot Refresh Strategy
- Default TTL 2 s; actions call `ensureFreshSnapshot()` which refreshes if older than TTL.
- When an action fails due to missing node, refresh once and retry (max one retry).
- Hook MutationObserver (throttled) to set `snapshotDirty = true` when significant mutations occur (node added/removed, attribute mutated).
- Provide manual `invalidateSnapshot()` for background commands.

### Algorithmic Details

**Traverse Element**
1. Evaluate visibility; if false and node has no visible descendants, skip.
2. Build `VirtualNode` with fields:
   - `text`: aggregated from direct text nodes (visible only, trimmed, newline normalized).
   - `value`: for inputs; sanitized via `stateExtractor` rules.
   - `actionable`: result from heuristics.
3. Collect child elements (`HTMLElement`, `SVGElement`, non-empty text nodes). Sort by DOM order.
4. For `iframe` elements:
   - Check `contentDocument`. If same-origin, recurse with depth guard (only root-level frames stored).
   - If inaccessible, add placeholder child describing the restriction.
5. For elements hosting `shadowRoot` (mode `'open'`), traverse root children separately and push into `shadowDom`.
6. Append Node to `nodeMap`, `reverseMap`.

**Text Extraction**
- Use `textContentExtractor.ts` but feed only visible nodes. Add inline summarization for long text nodes (>500 chars) with metadata `text_overflow: true`.
- Preserve semantic hints (e.g., prefix list items with bullet marker) to help the LLM parse.

**Summarization of Repeating Structures**
- Detect repeated sibling patterns (e.g., table rows, list items) via tag frequency.
- When exceeding thresholds (e.g., >50 siblings, aggregated text >1500 chars), produce summary node:
  - `tag: 'summary'`
  - `text: 'List of 120 items (product tiles). Showing first 20.'`
  - `children`: first N actual nodes.
  
**Accessibility & Semantics**
- Integrate `roleDetector` and `accessibleNameUtil` to populate `role` and `ariaLabel`.
- Map form state via `stateExtractor`: `checked`, `disabled`, `expanded`. These can be added to `VirtualNode` in future iterations (fields reserved).

### Interaction Pipeline in `content-script.ts`
1. Instantiate `const domTool = new DomTool();`.
2. Register new message types:
   - `'domtool:getSnapshot'` -> returns serialized payload.
   - `'domtool:click'`, `'domtool:type'`, `'domtool:keypress'`.
3. Existing `PAGE_ACTION_EXECUTE` handler adapts to call `domTool.click/type` when payload includes `nodeId`.
4. Legacy `captureInteractionContent` remains for compatibility; `DomTool` may optionally power it later.
5. Provide fallback responses when action fails (e.g., node not actionable, cross-origin frame) to help orchestrator decide next move.

### Telemetry, Logging & Debugging
- Collect metrics: snapshot build time, node count, truncation status, action success/failure reason.
- Emit logs with prefixed tag `[DomTool]` and structured data for QA sessions.
- Feature flag for `window.__browserxDebugDomTool = true` enabling extra logging and exposing `domTool` for manual inspection.

### Error Handling & Resilience
- If `document.body` is null (rare), return empty body with `meta.error = 'no-body'`.
- Wrap iframe access in `try/catch` to avoid security exceptions; record placeholder node with `actionable: false`.
- When event dispatch fails (element removed mid-action), refresh snapshot and return `retrySuggested: true`.
- Provide typed error objects (`DomToolError`) with categories (`NOT_FOUND`, `NOT_ACTIONABLE`, `CROSS_ORIGIN`, `SECURITY_BLOCKED`).

### Security & Privacy Considerations
- Do not record password-type inputs or elements flagged with `autocomplete="one-time-code"`.
- Limit captured text for `contentEditable` regions to first 1,000 characters; mark truncated content.
- Respect CSP/security: avoid injecting inline scripts; use existing content-script sandbox APIs.
- Ensure we never leak DOM outside active tab context or background logs unless sanitized.

### Testing Strategy
- **Unit** (`tests/unit/content/DomTool.test.ts`):
  - Visibility heuristics (simulate hidden via styles, zero rect).
  - Node ID stability (same structure => same ID).
  - Actionability detection for custom elements.
- **Integration** (`tests/integration/dom-operations/DomTool.interaction.test.ts`):
  - Build synthetic documents with iframes, shadow roots; verify serialized output and action routing.
  - Simulate DOM mutation between snapshot and action; ensure refresh + retry works.
- **Contract** (`tests/contract/llm-dom/serialization.test.ts`):
  - Snapshots for canonical pages (forms, dashboards) and diff against golden JSON.
- **Performance** (`tests/performance/domtool.bench.ts`):
  - Measure snapshot build time for large fixture (e.g., 1k nodes).
- **Playwright E2E** (future): drive actual browser with `DomTool` to verify real-world behavior.

### Rollout Plan
1. Implement `DomTool` and `DomSnapshot` behind `window.__browserxUseDomTool` flag.
2. Wire new message handlers; update orchestrator to request serialized DOM when flag enabled.
3. Beta test internally on curated sites (Gmail, Notion, Shopify admin) to validate interactions and payload size.
4. Collect telemetry, adjust heuristics (visibility thresholds, truncation limits).
5. Migrate LLM prompts to rely on `DomTool` payload; once stable, deprecate `interactionCapture`.

### Risks & Mitigations
- **Node ID Drift**: DOM reorders break structural IDs. *Mitigation*: include attribute hashing; allow orchestrator to request `selector` fallback as last resort.
- **Token Explosion**: Large dashboards overflow budget. *Mitigation*: summarization nodes, dynamic truncation, optional viewport-only capture.
- **Cross-Origin Limitations**: Inaccessible iframes reduce coverage. *Mitigation*: expose actionable metadata so LLM knows to open frame in new tab or request manual intervention.
- **Performance Regression**: Heavy traversal might block main thread. *Mitigation*: batch traversal with `requestIdleCallback` for very large pages; maintain incremental rebuild pipeline in later phase.
- **Event Synthesis Reliability**: Some frameworks expect native user gestures. *Mitigation*: use PointerEvents, call `element.click()` fallback, and optionally integrate `dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))`.

### Open Questions
1. Should we expose viewport coordinates (`boundingBox`) by default or store behind an `includeLayout` option?
2. Do we integrate MutationObserver for incremental updates now or defer to a later milestone?
3. How will background-service orchestrator distinguish between legacy and new payloads? Version header? Capability flag?
4. Should summarized nodes include aggregated natural language description generated locally (e.g., “Product list with prices”) to further aid the LLM?
5. What is the fallback plan if an action fails twice due to DOM churn? Should we request a fresh serialized DOM and prompt the LLM to replan?

### Appendix A: Interaction Event Ordering
- **Click**:
  1. `pointerover`, `pointerenter`
  2. `mouseover`, `mouseenter`
  3. `pointerdown`, `mousedown`
  4. Focus transfer (if applicable)
  5. `pointerup`, `mouseup`
  6. `click`
- **Type**:
  - For each character: `keydown`, optional `keypress`, DOM value mutation, `input`, `keyup`.
  - After sequence: `change` for blur or explicit submit triggers.
- **Keypress**:
  - `keydown` → optional `keypress` → `keyup`; handle default prevention checks.

### Appendix B: Compatibility With Existing Utilities
- `visibilityFilter.ts`: reuse `isNodeVisible`; extend with bounding box + clipping checks.
- `accessibleNameUtil.ts`, `roleDetector.ts`: populate `role`, `ariaLabel`.
- `selectorGenerator.ts`: still available as fallback when node ID resolution fails.
- `stateExtractor.ts`: provide field derivation for `VirtualNode.value` and flags.

### Appendix C: Future Enhancements
- Multi-level iframe traversal with streaming serialization.
- Diff-based updates allowing incremental prompts (“changed nodes since snapshot”).
- Bidirectional highlight overlay to debug node IDs visually.
- Integration with `IntersectionObserver` to capture only what is currently in viewport for low-latency interactions.
- Schema evolution to encode layout groups (e.g., grid cells, nav bars) and accelerate high-level reasoning.
