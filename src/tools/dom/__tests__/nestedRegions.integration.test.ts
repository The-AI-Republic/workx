/**
 * Integration Test: Nested Regions Scenario
 *
 * Purpose: Validates correct landmark region detection and hierarchical context
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Reference: specs/038-implement-captureinteractioncontent-request/spec.md - Scenario 4
 */

import { describe, it, expect } from 'vitest';
import { captureInteractionContent } from '@/tools/dom/interactionCapture';

describe('Integration: Nested Regions and Landmarks', () => {
  const nestedPageHtml = `
    <!DOCTYPE html>
    <html>
    <head><title>Nested Regions Test</title></head>
    <body>
      <header>
        <h1>Site Title</h1>
        <nav aria-label="Main navigation">
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
        </nav>
      </header>

      <main>
        <h2>Main Content</h2>

        <section>
          <h3>Featured Article</h3>
          <p>Article content...</p>
        </section>

        <aside aria-label="Related links">
          <h4>Related Articles</h4>
          <a href="/article1">Article 1</a>
          <a href="/article2">Article 2</a>
        </aside>

        <div role="search">
          <label for="search">Search</label>
          <input type="search" id="search" placeholder="Search...">
          <button type="submit">Search</button>
        </div>
      </main>

      <footer>
        <nav aria-label="Footer navigation">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
        <p>&copy; 2025</p>
      </footer>

      <div role="dialog" aria-label="Cookie consent" style="display: none;">
        <p>We use cookies</p>
        <button id="accept-cookies">Accept</button>
        <button id="reject-cookies">Reject</button>
      </div>
    </body>
    </html>
  `;

  it('should identify all landmark region types', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    expect(result.regions).toContain('header');
    expect(result.regions).toContain('navigation');
    expect(result.regions).toContain('main');
    expect(result.regions).toContain('aside');
    expect(result.regions).toContain('search');
    expect(result.regions).toContain('footer');
    expect(result.regions).toContain('dialog');

    // Regions should be unique
    const uniqueRegions = new Set(result.regions);
    expect(uniqueRegions.size).toBe(result.regions.length);
  });

  it('should tag controls with their containing region', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    // Navigation links should be tagged with "navigation"
    const navLinks = result.controls.filter(c =>
      c.region === 'navigation' && c.role === 'link'
    );

    expect(navLinks.length).toBeGreaterThanOrEqual(3); // Home, About, Contact (at minimum)

    // Search input should be tagged with "search"
    const searchInput = result.controls.find(c =>
      c.role === 'textbox' && c.selector.includes('search')
    );

    expect(searchInput).toBeDefined();
    expect(searchInput!.region).toBe('search');

    // Search button should be tagged with "search"
    const searchButton = result.controls.find(c =>
      c.role === 'button' && c.name.toLowerCase().includes('search')
    );

    if (searchButton) {
      expect(searchButton.region).toBe('search');
    }
  });

  it('should handle navigation inside header correctly', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    // Navigation links in header should be tagged as "navigation", not "header"
    const headerNavLinks = result.controls.filter(c =>
      c.role === 'link' && ['Home', 'About', 'Contact'].includes(c.name)
    );

    expect(headerNavLinks.length).toBeGreaterThanOrEqual(3);

    for (const link of headerNavLinks) {
      // Should be tagged with most specific landmark (navigation > header)
      expect(link.region).toBe('navigation');
    }
  });

  it('should handle navigation inside footer correctly', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    // Footer navigation links should be tagged as "navigation"
    const footerNavLinks = result.controls.filter(c =>
      c.role === 'link' && ['Privacy', 'Terms'].includes(c.name)
    );

    expect(footerNavLinks.length).toBeGreaterThanOrEqual(2);

    for (const link of footerNavLinks) {
      expect(link.region).toBe('navigation');
    }
  });

  it('should tag aside controls correctly', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    const asideLinks = result.controls.filter(c =>
      c.region === 'aside' && c.role === 'link'
    );

    expect(asideLinks.length).toBeGreaterThanOrEqual(2); // Article 1, Article 2
  });

  it('should extract hierarchical headings', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    expect(result.headings).toContain('Site Title');
    expect(result.headings).toContain('Main Content');
    expect(result.headings).toContain('Featured Article');
    expect(result.headings).toContain('Related Articles');
  });

  it('should handle dialog role elements', async () => {
    const result = await captureInteractionContent(nestedPageHtml, {});

    // Dialog region should be detected
    expect(result.regions).toContain('dialog');

    // Dialog buttons (if visible) should be tagged with "dialog" region
    const dialogButtons = result.controls.filter(c =>
      c.region === 'dialog'
    );

    // Since dialog is hidden (display: none), buttons may not be captured
    // But if they are, they should have correct region tag
    if (dialogButtons.length > 0) {
      expect(dialogButtons.some(b => b.name.includes('Accept'))).toBeTruthy();
    }
  });

  it('should handle nested landmarks with correct precedence', async () => {
    const html = `
      <html>
      <head><title>Nested Test</title></head>
      <body>
        <main>
          <section role="search">
            <input type="search" id="search1">
          </section>
          <aside>
            <nav>
              <a href="/link1">Link 1</a>
            </nav>
          </aside>
        </main>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const searchInput = result.controls.find(c => c.selector.includes('search1'));
    const asideNavLink = result.controls.find(c => c.name === 'Link 1');

    // Search input should be tagged with "search" (most specific)
    expect(searchInput).toBeDefined();
    expect(searchInput!.region).toBe('search');

    // Link inside nav inside aside should be tagged with "navigation" (most specific)
    expect(asideNavLink).toBeDefined();
    expect(asideNavLink!.region).toBe('navigation');
  });

  it('should preserve unique region list', async () => {
    const html = `
      <html>
      <head><title>Multiple Nav Test</title></head>
      <body>
        <nav><a href="/1">Link 1</a></nav>
        <nav><a href="/2">Link 2</a></nav>
        <nav><a href="/3">Link 3</a></nav>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    // Multiple nav elements should result in only one "navigation" region entry
    const navCount = result.regions.filter(r => r === 'navigation').length;
    expect(navCount).toBe(1);
  });

  it('should handle implicit ARIA roles (main, nav, header, footer)', async () => {
    const html = `
      <html>
      <head><title>Implicit Roles Test</title></head>
      <body>
        <header><a href="/">Header Link</a></header>
        <nav><a href="/nav">Nav Link</a></nav>
        <main><button>Main Button</button></main>
        <aside><a href="/aside">Aside Link</a></aside>
        <footer><a href="/footer">Footer Link</a></footer>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    expect(result.regions).toContain('header');
    expect(result.regions).toContain('navigation');
    expect(result.regions).toContain('main');
    expect(result.regions).toContain('aside');
    expect(result.regions).toContain('footer');

    const headerLink = result.controls.find(c => c.name === 'Header Link');
    const navLink = result.controls.find(c => c.name === 'Nav Link');
    const mainButton = result.controls.find(c => c.name === 'Main Button');
    const asideLink = result.controls.find(c => c.name === 'Aside Link');
    const footerLink = result.controls.find(c => c.name === 'Footer Link');

    expect(headerLink?.region).toBe('header');
    expect(navLink?.region).toBe('navigation');
    expect(mainButton?.region).toBe('main');
    expect(asideLink?.region).toBe('aside');
    expect(footerLink?.region).toBe('footer');
  });
});
