# Coordinate System - CSS Pixels Standard

## Overview

All coordinates in the BrowserX DOM system use **CSS pixels** (logical pixels), which is the web standard used by all JavaScript APIs like `getBoundingClientRect()`, `window.innerWidth`, etc.

## The Problem

Chrome DevTools Protocol's `DOMSnapshot.captureSnapshot()` returns bounding boxes in **device pixels** (physical pixels), which differ from CSS pixels by the device pixel ratio (DPR).

**Example:**
- Display with DPR = 1.5
- Element at CSS position x=100
- CDP returns device pixels: x=150
- Viewport width: 1920 CSS pixels = 2880 device pixels

Without conversion, an element at CSS x=100 would incorrectly appear at x=150 compared to a viewport of 1920.

## The Solution

**Normalize CDP device pixels to CSS pixels immediately upon capture.**

### Implementation

**Step 1: Capture DPR early** (`DomService.ts:197-209`)
```typescript
// Fetch device pixel ratio before building layout map
let devicePixelRatio = 1;
const dprResult = await this.sendCommand('Runtime.evaluate', {
  expression: 'window.devicePixelRatio',
  returnByValue: true
});
devicePixelRatio = dprResult.result.value;
```

**Step 2: Convert coordinates during extraction** (`DomService.ts:450-476`)
```typescript
// CDP returns device pixels, convert to CSS pixels
const devicePixels = { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] };

layoutData.boundingBox = {
  x: devicePixels.x / devicePixelRatio,
  y: devicePixels.y / devicePixelRatio,
  width: devicePixels.width / devicePixelRatio,
  height: devicePixels.height / devicePixelRatio
};
```

**Step 3: Use CSS pixels everywhere downstream** (`DomSnapshot.ts:358-434`)
```typescript
// All coordinates in CSS pixels - no conversion needed
const elemLeft = boundingBox.x - viewport.scrollX;
const elemRight = elemLeft + boundingBox.width;
const isVisible = elemRight <= viewport.width; // Direct comparison
```

## Benefits

1. **Web Standard Compatibility**: Matches `getBoundingClientRect()`, `window.innerWidth`, etc.
2. **Simplicity**: No conversion needed in calculations, serialization, or LLM interface
3. **Debuggability**: Console logs match Chrome DevTools measurements
4. **Future-proof**: Aligns with web platform standards

## Data Flow

```
CDP DOMSnapshot
  ↓ (device pixels: x=2167 at DPR=1.36)
DomService.buildLayoutMap()
  ↓ (convert: 2167 / 1.36 = 1593)
VirtualNode.boundingBox
  ↓ (CSS pixels: x=1593)
DomSnapshot.calculateInViewport()
  ↓ (compare: 1593 vs viewport.width=1595 ✓)
SerializedDom.bbox
  ↓ (CSS pixels: [1593, ...])
LLM Interface
```

## Verification

Run the extension and check console logs:

```javascript
// Expected output
[DomService] Viewport captured (CSS pixels - web standard):
  viewport: { width: 1595, height: 1003 }
  devicePixelRatio: 1.36

[DomService] Coordinate conversion [0]:
  devicePixels: { x: 2167, y: 156, width: 432, height: 48 }
  dpr: 1.36
  cssPixels: { x: 1593.38, y: 114.71, width: 317.65, height: 35.29 }
```

The CSS pixels should match:
- Element position in DevTools Elements panel
- `element.getBoundingClientRect()` values
- Visual position in the rendered page

## References

- [MDN: CSS pixels](https://developer.mozilla.org/en-US/docs/Glossary/CSS_pixel)
- [Web API: getBoundingClientRect](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect)
- [Device Pixel Ratio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)
- [Chrome DevTools Protocol: DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)
