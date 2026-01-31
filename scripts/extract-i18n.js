#!/usr/bin/env node

/**
 * Extract i18n translation keys from source files
 *
 * Workflow:
 * 1. Read _locales/supported_languages.json as source of truth
 * 2. Scan source files for t("...") and $_t("...") calls to find all texts
 * 3. Load/update _locales/key_map.json with text-to-key mappings
 * 4. Generate Chrome-compatible keys (only [a-zA-Z0-9_] allowed)
 * 5. Update _locales/{locale}/messages.json with generated keys
 * 6. Remove orphaned keys that are no longer used
 *
 * Key generation rules:
 * - Replace spaces and special characters with underscores
 * - Preserve case from original text
 * - If > 40 chars: truncate to 40 chars + "_" + 4-char hash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

/**
 * Generate a Chrome-compatible i18n key from original text
 * Rules:
 * - Replace spaces and special characters with underscores
 * - Preserve case
 * - If > 40 chars: truncate to 40 chars + "_" + 4-char hash
 *
 * @param {string} text - Original text
 * @returns {string} Chrome-compatible key
 */
function generateKey(text) {
  // Replace any character that's not [a-zA-Z0-9] with underscore
  let key = text.replace(/[^a-zA-Z0-9]/g, '_');

  // Collapse multiple underscores into one
  key = key.replace(/_+/g, '_');

  // Remove leading/trailing underscores
  key = key.replace(/^_+|_+$/g, '');

  // If key is too long, truncate and add hash
  if (key.length > 40) {
    const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 4);
    key = key.substring(0, 40) + '_' + hash;
  }

  // Ensure key is not empty
  if (!key) {
    const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
    key = 'key_' + hash;
  }

  return key;
}

/**
 * Extract placeholders from text and generate Chrome i18n placeholder definitions
 * Supports both named placeholders ($NAME$) and numbered ($1$, $2$)
 *
 * @param {string} text - Original text with placeholders
 * @returns {object|null} Placeholder definitions or null if none found
 */
function extractPlaceholders(text) {
  const placeholders = {};
  let substitutionIndex = 1;

  // Find all placeholders like $NAME$, $PLACEHOLDER$, $1$, $2$, etc.
  const placeholderPattern = /\$([A-Za-z0-9_]+)\$/g;
  let match;

  while ((match = placeholderPattern.exec(text)) !== null) {
    const placeholderName = match[1].toLowerCase();

    // Skip if already defined (avoid duplicates)
    if (placeholders[placeholderName]) continue;

    // Check if it's a numbered placeholder ($1$, $2$, etc.)
    if (/^\d+$/.test(match[1])) {
      placeholders[placeholderName] = {
        content: `$${match[1]}`
      };
    } else {
      // Named placeholder - map to substitution index
      placeholders[placeholderName] = {
        content: `$${substitutionIndex}`
      };
      substitutionIndex++;
    }
  }

  return Object.keys(placeholders).length > 0 ? placeholders : null;
}

/**
 * Convert BCP 47 locale code to Chrome locale directory name
 * e.g., 'zh-CN' -> 'zh_CN', 'en-US' -> 'en'
 */
function toChromeDirName(code) {
  // English uses 'en' directory
  if (code === 'en-US' || code === 'en') return 'en';
  // Convert hyphen to underscore for others
  return code.replace('-', '_');
}

/**
 * Extract t() calls from file content using regex
 */
function extractTranslationCalls(content, filePath) {
  const translations = [];

  // Match t("...") or t('...') or t(`...`)
  // Also match $_t("...") for the reactive translation store
  const patterns = [
    /\bt\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*(?:,\s*\{[^}]*\})?\s*\)/g,
    /\bt\(\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*(?:,\s*\{[^}]*\})?\s*\)/g,
    /\bt\(\s*`([^`\\]*(?:\\.[^`\\]*)*)`\s*(?:,\s*\{[^}]*\})?\s*\)/g,
    /\$_t\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*(?:,\s*\{[^}]*\})?\s*\)/g,
    /\$_t\(\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*(?:,\s*\{[^}]*\})?\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const text = match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      if (text.trim()) {
        translations.push({ text, file: filePath });
      }
    }
  }

  return translations;
}

/**
 * Extract data-i18n attributes from HTML content
 */
function extractDataI18nAttributes(content, filePath) {
  const translations = [];

  // Match data-i18n="..." attributes
  const pattern = /data-i18n="([^"]+)"/g;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    const text = match[1].trim();
    if (text) {
      translations.push({ text, file: filePath });
    }
  }

  return translations;
}

/**
 * Scan directory recursively for source files
 */
function scanDirectory(dir, extensions = ['.svelte', '.ts', '.js', '.html']) {
  const files = [];

  function scan(currentDir) {
    if (!fs.existsSync(currentDir)) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        if (extensions.includes(path.extname(entry.name))) {
          files.push(fullPath);
        }
      }
    }
  }

  scan(dir);
  return files;
}

// Keys required by manifest.json that must be preserved in all locales
const MANIFEST_REQUIRED_KEYS = ['extension_name', 'extension_description'];

/**
 * Main extraction function
 */
function extractI18n() {
  const projectRoot = path.join(__dirname, '..');
  const localesRoot = path.join(projectRoot, '_locales');
  const supportedLanguagesPath = path.join(localesRoot, 'supported_languages.json');
  const keyMapPath = path.join(localesRoot, 'key_map.json');

  log('\n🌐 Extracting i18n translation keys...', colors.cyan);

  // Step 1: Read supported_languages.json as source of truth
  let supportedLanguages = [];
  if (fs.existsSync(supportedLanguagesPath)) {
    try {
      supportedLanguages = JSON.parse(fs.readFileSync(supportedLanguagesPath, 'utf8'));
      log(`  📄 Loaded ${supportedLanguages.length} languages from supported_languages.json`, colors.reset);
    } catch (error) {
      log(`  ⚠ Error reading supported_languages.json: ${error.message}`, colors.yellow);
      return;
    }
  } else {
    log(`  ⚠ supported_languages.json not found, creating default`, colors.yellow);
    supportedLanguages = [
      { code: 'en-US', title: 'English (US)' }
    ];
    fs.mkdirSync(localesRoot, { recursive: true });
    fs.writeFileSync(supportedLanguagesPath, JSON.stringify(supportedLanguages, null, 2) + '\n');
  }

  // Step 2: Load existing key_map.json
  let keyMap = {};
  if (fs.existsSync(keyMapPath)) {
    try {
      keyMap = JSON.parse(fs.readFileSync(keyMapPath, 'utf8'));
      log(`  📄 Loaded ${Object.keys(keyMap).length} existing text-to-key mappings`, colors.reset);
    } catch (error) {
      log(`  ⚠ Error reading key_map.json: ${error.message}`, colors.yellow);
      keyMap = {};
    }
  }

  // Step 3: Scan source files for translation texts
  const dirsToScan = [
    path.join(projectRoot, 'src', 'sidepanel'),
    path.join(projectRoot, 'open_source', 'src'),
  ];

  const allTexts = new Set();

  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) {
      log(`  ⚠ Directory not found: ${dir}`, colors.yellow);
      continue;
    }

    const files = scanDirectory(dir);
    log(`  📂 Scanning ${files.length} files in ${path.relative(projectRoot, dir)}`, colors.reset);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(projectRoot, file);
      let translations = [];

      // Use appropriate extraction method based on file type
      if (file.endsWith('.html')) {
        translations = extractDataI18nAttributes(content, relPath);
      } else {
        translations = extractTranslationCalls(content, relPath);
      }

      for (const { text } of translations) {
        allTexts.add(text);
      }
    }
  }

  const allTextsList = Array.from(allTexts).sort();
  log(`  🔑 Found ${allTextsList.length} unique translation texts`, colors.reset);

  // Step 4: Update key_map.json with new texts
  let newKeysAdded = 0;
  const activeKeys = new Set();

  for (const text of allTextsList) {
    if (!keyMap[text]) {
      // Generate new key for this text
      keyMap[text] = generateKey(text);
      newKeysAdded++;
    }
    activeKeys.add(keyMap[text]);
  }

  // Remove orphaned texts from key_map (texts no longer in source)
  let orphanedTextsRemoved = 0;
  const textsToRemove = [];
  for (const text of Object.keys(keyMap)) {
    if (!allTexts.has(text)) {
      textsToRemove.push(text);
      orphanedTextsRemoved++;
    }
  }
  for (const text of textsToRemove) {
    delete keyMap[text];
  }

  // Write updated key_map.json
  fs.writeFileSync(keyMapPath, JSON.stringify(keyMap, null, 2) + '\n');

  if (newKeysAdded > 0) {
    log(`  ✨ Added ${newKeysAdded} new text-to-key mappings`, colors.green);
  }
  if (orphanedTextsRemoved > 0) {
    log(`  🗑️  Removed ${orphanedTextsRemoved} orphaned text mappings`, colors.yellow);
  }

  // Step 5: Process each supported language's messages.json
  let newLocalesCreated = 0;

  // Add manifest-required keys to active keys set
  for (const key of MANIFEST_REQUIRED_KEYS) {
    activeKeys.add(key);
  }

  for (const lang of supportedLanguages) {
    const dirName = toChromeDirName(lang.code);
    const localeDir = path.join(localesRoot, dirName);
    const messagesPath = path.join(localeDir, 'messages.json');
    const isEnglish = lang.code === 'en-US' || lang.code === 'en';

    // Create directory if missing
    if (!fs.existsSync(localeDir)) {
      fs.mkdirSync(localeDir, { recursive: true });
      log(`  📁 Created locale directory: ${dirName}`, colors.green);
      newLocalesCreated++;
    }

    // Load existing messages
    let existingMessages = {};
    if (fs.existsSync(messagesPath)) {
      try {
        existingMessages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
      } catch (error) {
        log(`  ⚠ Error reading ${dirName}/messages.json: ${error.message}`, colors.yellow);
      }
    }

    // Build messages object with generated keys
    const messages = {};
    let newKeys = 0;
    let removedKeys = 0;

    // First, preserve manifest-required keys (extension_name, extension_description)
    for (const key of MANIFEST_REQUIRED_KEYS) {
      if (existingMessages[key]) {
        messages[key] = existingMessages[key];
      }
    }

    // Add messages for each text using generated keys
    for (const text of allTextsList) {
      const key = keyMap[text];
      const placeholdersFromSource = extractPlaceholders(text);

      if (existingMessages[key]) {
        // Keep existing translation
        messages[key] = existingMessages[key];

        // Check both source text AND translated message for placeholders
        const placeholdersFromTranslation = messages[key].message
          ? extractPlaceholders(messages[key].message)
          : null;

        // Merge placeholders from both source and translation
        const allPlaceholders = {
          ...(placeholdersFromSource || {}),
          ...(placeholdersFromTranslation || {}),
        };

        if (Object.keys(allPlaceholders).length > 0) {
          messages[key].placeholders = allPlaceholders;
        }
      } else {
        // New key
        if (isEnglish) {
          // English: use the original text as the message
          messages[key] = { message: text };
        } else {
          // Other languages: empty string (to be translated)
          messages[key] = { message: '' };
        }
        // Add placeholder definitions if text contains placeholders
        if (placeholdersFromSource) {
          messages[key].placeholders = placeholdersFromSource;
        }
        newKeys++;
      }
    }

    // Count removed keys (keys in existing but not in active set)
    for (const key of Object.keys(existingMessages)) {
      if (!activeKeys.has(key)) {
        removedKeys++;
      }
    }

    // Write messages.json
    fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2) + '\n');

    if (newKeys > 0 || removedKeys > 0) {
      let status = [];
      if (newKeys > 0) status.push(`${newKeys} new`);
      if (removedKeys > 0) status.push(`${removedKeys} removed`);
      log(`  📝 ${dirName}: ${status.join(', ')}`, colors.reset);
    }
  }

  log(`\n✅ Extraction complete!`, colors.green);
  log(`  📊 Total texts: ${allTextsList.length}`, colors.green);
  log(`  📊 Languages: ${supportedLanguages.length}`, colors.green);
  if (newLocalesCreated > 0) {
    log(`  📁 New locale directories created: ${newLocalesCreated}`, colors.green);
  }

  return {
    totalTexts: allTextsList.length,
    languages: supportedLanguages.length,
    newLocalesCreated,
    newKeysAdded,
    orphanedTextsRemoved,
  };
}

// Run if called directly
if (require.main === module) {
  extractI18n();
}

module.exports = { extractI18n, generateKey };
