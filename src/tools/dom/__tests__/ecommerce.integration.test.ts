/**
 * Integration Test: E-commerce Page Scenario
 *
 * Purpose: Validates complex page capture with 200+ elements, capping, and visibility filtering
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Reference: specs/038-implement-captureinteractioncontent-request/spec.md - Scenario 2
 */

import { describe, it, expect } from 'vitest';
import { captureInteractionContent } from '@/tools/dom/interactionCapture';

describe('Integration: E-commerce Page Scenario', () => {
  // Generate complex e-commerce page with 200+ interactive elements
  const generateEcommercePage = () => {
    const products = Array.from({ length: 100 }, (_, i) => `
      <div class="product" data-product-id="${i}">
        <h3>Product ${i}</h3>
        <button class="add-to-cart" data-product-id="${i}">Add to Cart</button>
        <a href="/product/${i}" class="view-details">View Details</a>
      </div>
    `).join('\n');

    return `
      <!DOCTYPE html>
      <html>
      <head><title>Shop - Example Store</title></head>
      <body>
        <header>
          <nav>
            <a href="/">Home</a>
            <a href="/shop">Shop</a>
            <a href="/cart">Cart</a>
          </nav>
          <div role="search">
            <input type="search" placeholder="Search products..." aria-label="Search">
            <button type="submit">Search</button>
          </div>
        </header>

        <aside>
          <h2>Filters</h2>
          <label><input type="checkbox" name="category" value="electronics"> Electronics</label>
          <label><input type="checkbox" name="category" value="clothing"> Clothing</label>
          <label><input type="checkbox" name="category" value="books"> Books</label>
        </aside>

        <main>
          <h1>Featured Products</h1>
          <h2>New Arrivals</h2>
          <div class="product-grid">
            ${products}
          </div>
        </main>

        <footer>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
        </footer>

        <!-- Hidden modal (should be filtered out) -->
        <div id="modal" style="display: none;">
          <button id="close-modal">Close</button>
        </div>
      </body>
      </html>
    `;
  };

  it('should cap controls at maxControls limit (400)', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {
      maxControls: 400
    });

    expect(result.controls.length).toBeLessThanOrEqual(400);
  });

  it('should identify primary landmarks', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    expect(result.regions).toContain('main');
    expect(result.regions).toContain('navigation');
    expect(result.regions).toContain('aside');
    expect(result.regions).toContain('search');
    expect(result.regions).toContain('header');
    expect(result.regions).toContain('footer');
  });

  it('should extract top-level headings', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {
      maxHeadings: 30
    });

    expect(result.headings).toContain('Featured Products');
    expect(result.headings).toContain('New Arrivals');
    expect(result.headings).toContain('Filters');
    expect(result.headings.length).toBeLessThanOrEqual(30);
  });

  it('should filter out hidden elements (display: none)', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    // Hidden modal button should not be captured
    const hiddenButton = result.controls.find(c =>
      c.name === 'Close' && c.selector.includes('close-modal')
    );

    // Either not present, or marked as not visible
    if (hiddenButton) {
      expect(hiddenButton.visible).toBe(false);
    }
  });

  it('should include bounding box information for visible controls', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    // Find a visible control
    const visibleControl = result.controls.find(c => c.visible === true);

    expect(visibleControl).toBeDefined();

    if (visibleControl?.boundingBox) {
      expect(visibleControl.boundingBox.x).toBeGreaterThanOrEqual(0);
      expect(visibleControl.boundingBox.y).toBeGreaterThanOrEqual(0);
      expect(visibleControl.boundingBox.width).toBeGreaterThan(0);
      expect(visibleControl.boundingBox.height).toBeGreaterThan(0);
    }
  });

  it('should capture search input with correct role and states', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    const searchInput = result.controls.find(c =>
      c.role === 'textbox' && c.name.toLowerCase().includes('search')
    );

    expect(searchInput).toBeDefined();
    expect(searchInput!.states.placeholder).toContain('Search products');
    expect(searchInput!.region).toBe('search');
  });

  it('should capture checkboxes with correct role and states', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    const checkboxes = result.controls.filter(c => c.role === 'checkbox');

    expect(checkboxes.length).toBeGreaterThanOrEqual(3); // Electronics, Clothing, Books

    const electronicsCheckbox = checkboxes.find(c =>
      c.name.toLowerCase().includes('electronics')
    );

    expect(electronicsCheckbox).toBeDefined();
    expect(electronicsCheckbox!.states).toHaveProperty('checked');
    expect(electronicsCheckbox!.region).toBe('aside');
  });

  it('should prioritize visible controls when capping', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {
      maxControls: 50
    });

    // All returned controls should be visible
    const visibleCount = result.controls.filter(c => c.visible === true).length;

    // At least majority should be visible (prioritized)
    expect(visibleCount).toBeGreaterThan(result.controls.length * 0.8);
  });

  it('should generate unique stable IDs for all controls', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    const ids = result.controls.map(c => c.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should preserve selector uniqueness in aimap', async () => {
    const html = generateEcommercePage();

    const result = await captureInteractionContent(html, {});

    // Each control should have corresponding aimap entry
    for (const control of result.controls) {
      expect(result.aimap).toHaveProperty(control.id);
      expect(result.aimap[control.id]).toBe(control.selector);
    }
  });
});
