#!/usr/bin/env node

/**
 * Build script for Chrome extension
 * Copies manifest and builds with Vite
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function build() {
  try {
    log('\n🔨 Building Browserx Chrome Extension...', colors.yellow);
    
    // Clean dist directory
    const distPath = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(distPath)) {
      fs.rmSync(distPath, { recursive: true });
    }
    fs.mkdirSync(distPath, { recursive: true });
    
    // Run Vite build for main scripts
    log('\n📦 Building main scripts with Vite...', colors.yellow);
    execSync('npm run vite:build', { stdio: 'inherit' });

    // Build content script separately (must be IIFE)
    log('\n📦 Building content script (IIFE)...', colors.yellow);
    execSync('vite build --config vite.config.content.mjs', { stdio: 'inherit' });
    
    // Copy manifest
    log('\n📄 Copying manifest...', colors.yellow);
    const manifestSrc = path.join(__dirname, '..', 'manifest.json');
    const manifestDest = path.join(distPath, 'manifest.json');
    fs.copyFileSync(manifestSrc, manifestDest);

    // Track 20: Chrome managed_storage schema (admin enterprise policy channel)
    const managedSchemaSrc = path.join(__dirname, '..', 'managed-schema.json');
    if (fs.existsSync(managedSchemaSrc)) {
      fs.copyFileSync(managedSchemaSrc, path.join(distPath, 'managed-schema.json'));
    }

    // Copy and fix HTML files
    log('\n📄 Copying and fixing HTML files...', colors.yellow);
    const htmlFiles = [
      { src: 'src/webfront/sidepanel.html', dest: 'sidepanel.html' },
      { src: 'src/welcome/welcome.html', dest: 'welcome.html' }
    ];

    htmlFiles.forEach(file => {
      const srcPath = path.join(distPath, file.src);
      const destPath = path.join(distPath, file.dest);
      if (fs.existsSync(srcPath)) {
        // Read the HTML file
        let htmlContent = fs.readFileSync(srcPath, 'utf8');

        // Fix paths - remove leading slashes for Chrome extension
        htmlContent = htmlContent
          .replace(/src="\/([^"]+)"/g, 'src="$1"')
          .replace(/href="\/([^"]+)"/g, 'href="$1"');

        // Write the fixed HTML
        fs.writeFileSync(destPath, htmlContent);
        log(`  ✓ Copied and fixed ${file.dest}`, colors.green);
      } else {
        log(`  ⚠ Missing ${file.src}`, colors.yellow);
      }
    });
    
    // Copy oauth-success.html (used by declarativeNetRequest OAuth redirect)
    const oauthSuccessSrc = path.join(__dirname, '..', 'src', 'extension', 'pages', 'oauth-success.html');
    if (fs.existsSync(oauthSuccessSrc)) {
      fs.copyFileSync(oauthSuccessSrc, path.join(distPath, 'oauth-success.html'));
      log('  ✓ Copied oauth-success.html', colors.green);
    }

    // Copy static assets directory
    const staticPath = path.join(__dirname, '..', 'src', 'static');
    if (fs.existsSync(staticPath)) {
      log('\n🎨 Copying static assets...', colors.yellow);
      const staticDest = path.join(distPath, 'static');
      fs.mkdirSync(staticDest, { recursive: true });

      fs.readdirSync(staticPath).forEach(file => {
        fs.copyFileSync(
          path.join(staticPath, file),
          path.join(staticDest, file)
        );
      });
      log('  ✓ Copied static directory', colors.green);
    }

    // Copy icons directory if it exists
    const iconsPath = path.join(__dirname, '..', 'icons');
    if (fs.existsSync(iconsPath)) {
      log('\n🎨 Copying icons...', colors.yellow);
      const iconsDest = path.join(distPath, 'icons');
      fs.mkdirSync(iconsDest, { recursive: true });

      fs.readdirSync(iconsPath).forEach(file => {
        fs.copyFileSync(
          path.join(iconsPath, file),
          path.join(iconsDest, file)
        );
      });
    }
    
    // Copy prompts directory
    const promptsSrc = path.join(__dirname, '..', 'src', 'prompts');
    const promptsDest = path.join(distPath, 'prompts');
    if (fs.existsSync(promptsSrc)) {
      log('\n📝 Copying prompts...', colors.yellow);
      fs.mkdirSync(promptsDest, { recursive: true });
      fs.readdirSync(promptsSrc).forEach(file => {
        const srcFile = path.join(promptsSrc, file);
        // Skip directories (e.g., fragments/) — fragments are inlined by Vite ?raw
        // imports at build time, so they don't need to be copied to dist
        if (!fs.statSync(srcFile).isFile()) return;
        fs.copyFileSync(srcFile, path.join(promptsDest, file));
      });
      log('  ✓ Copied prompts directory', colors.green);
    }

    // Copy _locales directory (required for i18n)
    const localesPath = path.join(__dirname, '..', '_locales');
    if (fs.existsSync(localesPath)) {
      log('\n🌍 Copying locale files...', colors.yellow);
      const localesDest = path.join(distPath, '_locales');

      function copyRecursive(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src, { withFileTypes: true }).forEach(entry => {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyRecursive(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        });
      }

      copyRecursive(localesPath, localesDest);
      log('  ✓ Copied _locales directory', colors.green);
    }

    // Create placeholder icons if they don't exist
    const iconsDest = path.join(distPath, 'icons');
    if (!fs.existsSync(iconsDest)) {
      fs.mkdirSync(iconsDest, { recursive: true });
      
      // Create simple SVG icons as placeholders
      const sizes = [16, 48, 128];
      sizes.forEach(size => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <rect width="${size}" height="${size}" fill="#4f46e5"/>
          <text x="50%" y="50%" font-family="Arial" font-size="${size * 0.4}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">C</text>
        </svg>`;
        
        fs.writeFileSync(
          path.join(iconsDest, `icon${size}.svg`),
          svg
        );
      });
    }
    
    // Check build output
    const requiredFiles = [
      'manifest.json',
      'background.js',
      'content.js',
      'sidepanel.html',
      'welcome.html'
    ];
    
    const missingFiles = requiredFiles.filter(
      file => !fs.existsSync(path.join(distPath, file))
    );
    
    if (missingFiles.length > 0) {
      log(`\n⚠️  Warning: Missing files in build output:`, colors.yellow);
      missingFiles.forEach(file => log(`  - ${file}`, colors.yellow));
    }
    
    log('\n✅ Build complete!', colors.green);
    log(`\n📁 Extension built to: ${distPath}`, colors.green);
    log('\nTo load the extension:', colors.reset);
    log('1. Open Chrome and navigate to chrome://extensions/', colors.reset);
    log('2. Enable "Developer mode"', colors.reset);
    log('3. Click "Load unpacked"', colors.reset);
    log(`4. Select the ${distPath} directory`, colors.reset);
    
  } catch (error) {
    log(`\n❌ Build failed: ${error.message}`, colors.red);
    process.exit(1);
  }
}

// Run build
build();
