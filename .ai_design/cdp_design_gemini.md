Here is a comprehensive design document based on our conversation, detailing the CDP-based hybrid architecture for your `DomTool`.

-----

## **Design Doc: CDP-Powered Hybrid DOM Tool (v3.0)**

**Author:** Gemini
**Status:** Design Proposal

### **1. Executive Summary**

This document proposes a complete architectural refactor of the `DomTool`. The current content-script-based vDOM implementation is brittle, unable to reliably handle multi-frame/shadow-DOM pages, and struggles to identify all interactive elements.

This new design (v3.0) moves all core logic to the extension's **service worker** and leverages the **Chrome DevTools Protocol (CDP)** for all page interaction.

It uses a **"DOM-first, A11y-Enriched"** hybrid model. The full DOM tree provides a complete structural backbone, while the Accessibility (A11y) tree provides a rich layer of semantic data. This solves the core problem of missing non-semantic, JS-driven interactive elements that an A11y-only approach would not capture.

The agent will operate on a strict, **closed-loop "Observe-Act" workflow**, re-snapshotting the page after every action to ensure it never operates on stale data.

-----

### **2. Core Design Principles**

1.  **Reliability over Speed:** The agent must *always* act on the most current page state. We will not use "open-loop" (multi-step) plans.
2.  **Completeness over Purity:** We must capture *all* interactive elements, including both semantically-correct (`<button>`) and "broken" (`<div onclick>`) ones.
3.  **Semantic Abstraction:** The LLM must receive a clean, flattened, token-efficient, and human-readable representation of the page, not a raw DOM dump.
4.  **Centralized Logic:** All state and logic (snapshotting, vDOM, action execution) will reside in the service worker. Content scripts will be "dumb clients" for visual effects only.

-----

### **3. System Architecture & Workflow**

The entire system is managed from the service worker, which is attached to the target tab via `chrome.debugger`.

#### **System Diagram**

```
┌──────────────────────────────────────────────────────────────────┐
│                      Background Service Worker                     │
│                                                                  │
│  ┌────────────────────┐      ┌──────────────────────────────────┐  │
│  │     DomTool (v3)   │      │         DomSnapshot (v3)         │  │
│  │ (The "Brain")      │      │       (Immutable Cache)          │  │
│  │ - Manages Cache    ├─────►│ ┌──────────────────────────────┐ │  │
│  │ - Manages Loop     │      │ │    Complete VirtualNode Tree │ │  │
│  │ - Executes Actions │      │ │   (DOM-first, A11y-Enriched) │ │  │
│  │ - Serializes DOM   │      │ ├──────────────────────────────┤ │  │
│  └─────────┬──────────┘      │ │ Map<"node_7", backendNodeId> │ │  │
│            │                 │ └──────────────────────────────┘ │  │
│            └─────────────────┴──────────────────────────────────┘  │
│                      │ ▲                                         │
│  (CDP Commands:     │ │ (CDP Events: DOM.documentUpdated)         │
│   "DOM.getDocument" │ │  (Invalidates cache)                       │
│   "A11y.getTree"    │ │                                         │
│   "Input.click")    │ │                                         │
│                      ▼ │                                         │
└──────────────────────┼───────────────────────────────────────────┘
                       │
                       │ chrome.debugger.sendCommand / onEvent
                       │
┌──────────────────────▼───────────────────────────────────────────┐
│                      Browser (Target Tab)                        │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │                  Real DOM (incl. all frames)                 │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

#### **Core "Observe-Act" Loop (Closed-Loop Execution)**

This is the non-negotiable workflow for the agent.

1.  **[Observe]** The agent controller needs to "see" the page. It calls `domTool.getSerializedDom()`.
2.  **[Snapshot]** `domTool` checks its internal cache (`currentSnapshot`).
      * **If `null` (stale):** It runs the **Full Snapshot Workflow** (see below), builds a new `DomSnapshot`, and caches it.
      * **If `valid` (cached):** It uses the existing `DomSnapshot`.
3.  **[Serialize]** The `domTool` runs its **Flattening Logic** (see below) on the `DomSnapshot`'s vDOM tree to generate the token-efficient JSON.
4.  **[Think]** The flattened JSON is sent to the LLM. The LLM returns **one single action** (e.g., `{ action: "click", nodeId: "node_7" }`).
5.  **[Act]** The controller passes this action to `domTool.click("node_7")`.
6.  **[Execute]** `domTool` performs the action using CDP (`Input.dispatchMouseEvent`).
7.  **[Invalidate]** Upon successful execution, `domTool` immediately sets `this.currentSnapshot = null`.
8.  The loop repeats. The next `getSerializedDom()` call (Step 1) is forced to re-run the **Full Snapshot Workflow**, capturing the page state *after* the action.

-----

### **4. Full Snapshot Workflow (The Hybrid Tree)**

This is the core of the `DomTool`'s "Observe" step.

1.  **Fetch Both Sources (Parallel):**
      * Call `Accessibility.getFullAXTree({ depth: -1 })` to get the **A11y Tree**.
      * Call `DOM.getDocument({ depth: -1, pierce: true })` to get the **DOM Tree** (this is our structural backbone).
2.  **Build Enrichment Map:**
      * Quickly iterate the `A11y Tree` JSON.
      * Create a `Map<number, AXNode>` (e.g., `Map<backendDOMNodeId, axNodeData>`).
      * This map is our "cheat sheet" for high-quality semantic data (computed roles and names).
3.  **Build Hybrid vDOM:**
      * Write a single recursive function that walks the **DOM Tree** JSON from its root.
      * For each `domNode` in the walk:
          * Get its `backendNodeId`.
          * Check the map: `const axNode = enrichmentMap.get(backendNodeId);`
          * **Case 1 (Semantic Node):** If `axNode` exists, it's a "good" node. Create a `VirtualNode` using the rich A11y data:
              * `role: axNode.role.value`
              * `name: axNode.name.value`
              * `states: { disabled: axNode.disabled, ... }`
          * **Case 2 (Non-Semantic Node):** If `axNode` is `undefined`, the A11y tree ignored it. We must run our v1 heuristics:
              * Does it have an `onclick` attribute?
              * Does it have a `data-testid`?
              * Is it a `<p>` with significant text?
              * If it passes, create a "gap-filler" `VirtualNode`:
                  * `role: domNode.nodeName.toLowerCase()` (e.g., "div")
                  * `name: domNode.textContent` (or compute)
          * **Case 3 (Junk Node):** If it's a non-semantic, non-interactive `<div>`, we still create a basic `VirtualNode` for it. **Flattening is a separate pass.** This ensures our vDOM is a 1:1 structural mirror, which is required to place "gap-filler" nodes correctly.
4.  **Store:** The resulting `VirtualNode` tree (which is a complete, 1:1, semantically-enriched mirror of the DOM) and the `Map<"node_x", backendNodeId>` are stored in a new `DomSnapshot` object, which is then cached.

-----

### **5. Flattening & Serialization (For the LLM)**

This is a **separate step** that runs *after* the hybrid vDOM is built. It uses the exact logic from the v1 design doc.

1.  The agent calls `domTool.getSerializedDom()`.
2.  `domTool` retrieves or builds its `DomSnapshot`.
3.  It then calls a `serializeAndFlatten(snapshot.virtualDom)` function.
4.  This function recursively walks the **complete `VirtualNode` tree** and builds the `SerializedDom` JSON.
5.  **Flattening Rules:**
      * **✅ Keep:** Semantic nodes (`button`, `link`, `textbox`, `heading`), "gap-filler" nodes (`<div onclick>`), and semantic groups (`form`, `table`).
      * **❌ Discard & Hoist:** Purely structural nodes (e.g., a `<div>` with no text, no `onclick`, and a generic `role`). Its children are recursively processed and attached to its parent in the *serialized* output.

This two-pass system (Build Full Tree → Flatten for LLM) is the key. It solves the problem of where to insert "gap-filler" nodes.

-----

### **6. Core Data Structures**

#### **`VirtualNode` (Internal, Complete Tree)**

```typescript
/**
 * Represents a single node in the service worker's complete,
 * 1:1 mirror of the DOM. Built from the DOM tree and
 * enriched by the A11y tree.
 */
interface VirtualNode {
  /** Our internal, stable, LLM-facing ID (e.g., "node_7") */
  node_id: string;

  /**
   * The *best available* role.
   * (e.g., "button" from A11y, or "div" from DOM)
   */
  role: string;

  /** The *best available* name. (e.g., "Log In" from A11y) */
  name: string;

  /** States from A11y tree (e.g., disabled, checked) */
  states: Record<string, boolean | string>;

  /** Full child list, mirroring the DOM structure */
  children: VirtualNode[];
}
```

#### **`DomSnapshot` (Immutable Cache)**

```typescript
/**
 * An immutable snapshot of the page's complete state.
 * This is what gets cached in the DomTool.
 */
class DomSnapshot {
  /** The root of the complete, 1:1 hybrid vDOM tree */
  readonly virtualDom: VirtualNode;

  /**
   * The "key" for action.
   * Maps our stable "node_7" to the browser's internal ID.
   * Map<llm_facing_id, backendDOMNodeId>
   */
  private readonly nodeIdToBackendId: Map<string, number>;

  constructor(root: VirtualNode, map: Map<string, number>) {
    this.virtualDom = root;
    this.nodeIdToBackendId = map;
  }

  /** Gets the browser's internal ID for action. */
  public getBackendId(nodeId: string): number | undefined {
    return this.nodeIdToBackendId.get(nodeId);
  }
}
```

#### **`SerializedNode` (External, Flattened JSON)**

This is the token-efficient JSON for the LLM (from your v1 doc).

```typescript
/**
 * The simplified, flattened node for LLM consumption.
 * Unnecessary containers are removed.
 */
interface SerializedNode {
  id: string; // e.g., "node_7"
  tag: string; // or role
  role?: string;
  name?: string; // "aria-label" in v1
  text?: string;
  children?: SerializedNode[]; // Only for semantic groups (forms)
  // ... other metadata like href, disabled, checked
}
```

-----

### **7. Example Code (Core `click` Action)**

This code lives in the **service worker's `DomTool` class**.

```typescript
/**
 * Promisified helper for sending CDP commands.
 */
function sendCdpCommand(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: object
): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      resolve(result);
    });
  });
}

/**
 * [ACT] Executes a click action.
 */
public async click(nodeId: string): Promise<ActionResult> {
  if (!this.currentSnapshot) {
    // This should never happen in a proper Observe-Act loop.
    return { success: false, error: "Snapshot is stale. Agent must observe first." };
  }

  // 1. Find the browser's internal ID
  const backendId = this.currentSnapshot.getBackendId(nodeId);
  if (!backendId) {
    this.invalidateSnapshot(); // Invalidate on failure too
    return { success: false, error: `Element "${nodeId}" not in snapshot.` };
  }

  try {
    // 2. Get the element's coordinates
    // This also serves as a "visibility" and "staleness" check.
    // If the node is gone, this command will fail.
    const boxModel = await sendCdpCommand(this.debuggee, "DOM.getBoxModel", {
      backendNodeId: backendId,
    });

    const { content } = boxModel.model;
    // Calculate center of the content box
    const x = Math.round(content[0] + (content[2] - content[0]) / 2);
    const y = Math.round(content[1] + (content[7] - content[1]) / 2);

    // 3. Send visual effect to content script (fire and forget)
    chrome.tabs.sendMessage(this.debuggee.tabId, { type: "SHOW_CURSOR", x, y });
    
    // Optional: Wait 50-100ms for visual effect to render

    // 4. Dispatch a real, reliable mouse event
    await sendCdpCommand(this.debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1
    });
    await sendCdpCommand(this.debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1
    });

    // 5. [INVALIDATE] This is the most important step.
    this.invalidateSnapshot();
    
    return { success: true };

  } catch (e: any) {
    // Action failed (e.g., element was off-screen or detached)
    this.invalidateSnapshot(); // Always invalidate on error
    return { success: false, error: e.message };
  }
}
```