#!/usr/bin/env node

/**
 * i18n Translation and Validation Tools
 *
 * Commands:
 *   npm run translate          - Auto-translate missing translations
 *   npm run translate-validate - Validate existing translations
 *
 * Configuration: Edit the CONFIG object below
 *
 * Note: This script uses _locales/key_map.json to find original English text
 * for each key. The original text is used for translation, not the generated key.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION - Edit these values
// ============================================================================
const CONFIG = {
  // Fireworks API configuration
  // Set FIREWORKS_API_KEY environment variable before running
  apiKey: process.env.FIREWORKS_API_KEY,
  apiUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',

  // Model for TRANSLATION
  // Options: 'accounts/fireworks/models/llama-v3p1-70b-instruct'
  //          'accounts/fireworks/models/llama-v3p1-8b-instruct'
  //          'accounts/fireworks/models/mixtral-8x7b-instruct'
  //          'accounts/fireworks/models/qwen2p5-72b-instruct'
  translationModel: 'accounts/fireworks/models/gpt-oss-120b',

  // Model for VALIDATION (can be different from translation)
  validationModel: 'accounts/fireworks/models/deepseek-v3p2',

  // Batch size - number of keys per API call
  batchSize: 20,

  // Delay between API calls (ms) to avoid rate limiting
  delayBetweenCalls: 500,

  // Output file for validation report
  validationReportPath: '_locales/validation-report.json',

  // Keys to skip during translation/validation (brand names that should never be translated)
  skipKeys: ['extension_name'],

  // Fixed values that should never be translated (brand name)
  fixedValues: {
    extension_name: 'BrowserX',
  },

  // Keys whose English source text comes from _locales/en/messages.json (not key_map.json)
  // These are translated normally but use the English messages.json as source of truth
  sourceFromEnMessages: ['extension_description'],
};

// ============================================================================
// Key Map Helper - Load text-to-key mappings
// ============================================================================

/**
 * Load key_map.json and build reverse lookup (key -> original text)
 */
function loadKeyMap(localesRoot) {
  const keyMapPath = path.join(localesRoot, 'key_map.json');

  if (!fs.existsSync(keyMapPath)) {
    log(`  ⚠ key_map.json not found. Run extract-i18n.js first.`, colors.yellow);
    return { textToKey: {}, keyToText: {} };
  }

  try {
    const textToKey = JSON.parse(fs.readFileSync(keyMapPath, 'utf8'));
    // Build reverse lookup: key -> original text
    const keyToText = {};
    for (const [text, key] of Object.entries(textToKey)) {
      keyToText[key] = text;
    }
    return { textToKey, keyToText };
  } catch (error) {
    log(`  ⚠ Error reading key_map.json: ${error.message}`, colors.yellow);
    return { textToKey: {}, keyToText: {} };
  }
}

// ============================================================================
// Language info helper
// ============================================================================

/**
 * Extract language info from supported_languages.json entry
 */
function getLangInfo(lang) {
  // Extract name from title (e.g., "Chinese (简体中文)" -> "Chinese")
  const name = lang.title.split('(')[0].trim();
  // Extract native name from title (e.g., "Chinese (简体中文)" -> "简体中文")
  const nativeMatch = lang.title.match(/\(([^)]+)\)/);
  const nativeName = nativeMatch ? nativeMatch[1] : name;

  return {
    name,
    nativeName,
    instructions: lang.translate_instructions || 'Translate naturally for UI context.',
  };
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

/**
 * Call Fireworks API
 */
async function callFireworksAPI(prompt, model) {
  const response = await fetch(CONFIG.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Fireworks API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Parse JSON from LLM response
 */
function parseJSONResponse(response) {
  try {
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```\n?/g, '');
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse LLM response:', response);
    throw new Error(`Failed to parse response: ${error.message}`);
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert BCP 47 locale code to Chrome locale directory name
 */
function toChromeDirName(code) {
  if (code === 'en-US' || code === 'en') return 'en';
  return code.replace('-', '_');
}

/**
 * Check API key is configured
 */
function checkApiKey() {
  if (!CONFIG.apiKey) {
    log('\n❌ Error: Fireworks API key not configured!', colors.red);
    log('  Set FIREWORKS_API_KEY environment variable before running this script.', colors.yellow);
    log('  Example: FIREWORKS_API_KEY=fw_xxx npm run translate', colors.yellow);
    process.exit(1);
  }
}

/**
 * Load supported languages
 */
function loadSupportedLanguages(localesRoot) {
  const supportedLanguagesPath = path.join(localesRoot, 'supported_languages.json');
  try {
    return JSON.parse(fs.readFileSync(supportedLanguagesPath, 'utf8'));
  } catch (error) {
    log(`❌ Error reading supported_languages.json: ${error.message}`, colors.red);
    process.exit(1);
  }
}

/**
 * Load English messages to get reference values
 */
function loadEnglishMessages(localesRoot) {
  const enMessagesPath = path.join(localesRoot, 'en', 'messages.json');
  try {
    return JSON.parse(fs.readFileSync(enMessagesPath, 'utf8'));
  } catch (error) {
    log(`❌ Error reading English messages.json: ${error.message}`, colors.red);
    process.exit(1);
  }
}

/**
 * Validate and fix extension_name in a locale
 * - extension_name must always be "BrowserX" (no translation)
 * Returns: { fixed: boolean, issues: string[] }
 */
function validateManifestKeys(messages) {
  const issues = [];
  let fixed = false;

  // Check extension_name - must always be "BrowserX"
  if (messages.extension_name) {
    const expected = CONFIG.fixedValues.extension_name;
    if (messages.extension_name.message !== expected) {
      issues.push(`extension_name: "${messages.extension_name.message}" → "${expected}"`);
      messages.extension_name.message = expected;
      fixed = true;
    }
  }

  return { fixed, issues };
}

/**
 * Get the original English text for a key
 * - For keys in sourceFromEnMessages, use _locales/en/messages.json
 * - For other keys, use key_map.json
 */
function getOriginalText(key, keyToText, enMessages) {
  if (CONFIG.sourceFromEnMessages.includes(key) && enMessages[key]) {
    return enMessages[key].message;
  }
  return keyToText[key] || key;
}

// ============================================================================
// TRANSLATION FUNCTIONS
// ============================================================================

/**
 * Build the translation prompt using original English text (not keys)
 */
function buildTranslationPrompt(targetLang, langInfo, textsToTranslate) {
  const textsList = textsToTranslate
    .map((text, i) => `${i + 1}. "${text}"`)
    .join('\n');

  return `You are a professional translator specializing in software UI localization.

Task: Translate the following English UI text strings to ${langInfo.name} (${langInfo.nativeName}).

Target Language: ${langInfo.name}
Language Code: ${targetLang}

Translation Guidelines:
- Keep translations concise and natural for UI context
- Maintain the same tone (formal/informal) as the original
- CRITICAL: Preserve ALL placeholders exactly as they appear (e.g., $NAME$, $1$, $2$, etc.)
  - Placeholders are variables that get replaced at runtime
  - Do NOT translate, modify, or remove placeholders
  - Example: "Hello $NAME$" → "你好 $NAME$" (NOT "你好 名字" or "你好")
- Keep technical terms (API, LLM, AI, URL, etc.) in English unless there's a widely accepted translation
- Do not add or remove punctuation unless necessary for the target language
- ${langInfo.instructions}

English strings to translate:
${textsList}

Respond with ONLY a JSON object mapping the original English text to the translation.
Format: {"English text": "Translation", ...}

Example response format:
{"Settings": "设置", "Hello $NAME$": "你好 $NAME$"}

Important: Return ONLY the JSON object, no markdown, no explanation.`;
}

/**
 * Build prompt for reviewing flagged translations from validation report
 */
function buildReviewPrompt(targetLang, langInfo, flaggedItems) {
  const itemsList = flaggedItems
    .map((item, i) => `${i + 1}. English: "${item.originalText}"
   Current translation: "${item.translation}"
   Validation feedback: ${item.description}`)
    .join('\n\n');

  return `You are a professional translator specializing in software UI localization.

Task: Review flagged ${langInfo.name} (${langInfo.nativeName}) translations based on validation feedback.

Target Language: ${langInfo.name}
Language Code: ${targetLang}

Guidelines:
- Review each flagged translation and the validation feedback
- Use your own judgment - the feedback is a suggestion, not a strict requirement
- If the current translation is actually correct or acceptable, keep it as is
- If the feedback makes sense and the translation should be improved, provide a better translation
- Keep translations concise and natural for UI context
- CRITICAL: Preserve ALL placeholders exactly as they appear (e.g., $NAME$, $1$, $2$, etc.)
  - Placeholders are variables that get replaced at runtime - do NOT translate or modify them
- ${langInfo.instructions}

Flagged translations to review:
${itemsList}

For each item, decide whether to KEEP the current translation or UPDATE it.
Respond with ONLY a JSON object mapping the English text to the final translation.
- If keeping the current translation, use the same value
- If updating, use the new improved translation

Format: {"English text": "final translation", ...}

Example response:
{"Settings": "设置", "Hello $NAME$": "你好 $NAME$"}

Important: Return ONLY the JSON object, no markdown, no explanation.`;
}

/**
 * Load validation report if exists
 */
function loadValidationReport(projectRoot) {
  const reportPath = path.join(projectRoot, CONFIG.validationReportPath);
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    log(`  ⚠ Could not read validation report: ${error.message}`, colors.yellow);
    return null;
  }
}

/**
 * Main translation function
 */
async function translateMissing() {
  const projectRoot = path.join(__dirname, '..');
  const localesRoot = path.join(projectRoot, '_locales');
  const reportPath = path.join(projectRoot, CONFIG.validationReportPath);

  log('\n🌍 i18n Translation Tool', colors.cyan);
  checkApiKey();

  // Load English messages for reference values
  const enMessages = loadEnglishMessages(localesRoot);

  // Load key_map.json for text <-> key mapping
  const { textToKey, keyToText } = loadKeyMap(localesRoot);
  const hasKeyMap = Object.keys(keyToText).length > 0;

  if (!hasKeyMap) {
    log('  ⚠ No key mappings found. Using keys directly for translation.', colors.yellow);
  } else {
    log(`  📄 Loaded ${Object.keys(keyToText).length} key-to-text mappings`, colors.reset);
  }

  const supportedLanguages = loadSupportedLanguages(localesRoot);
  const targetLanguages = supportedLanguages.filter(
    lang => lang.code !== 'en-US' && lang.code !== 'en'
  );

  if (targetLanguages.length === 0) {
    log('  No target languages to translate.', colors.yellow);
    return;
  }

  log(`  Found ${targetLanguages.length} target language(s): ${targetLanguages.map(l => l.code).join(', ')}`, colors.reset);

  // Load validation report if exists
  const validationReport = loadValidationReport(projectRoot);
  if (validationReport) {
    log(`  📋 Found validation report with flagged translations`, colors.cyan);
  }

  let totalTranslated = 0;
  let totalReviewed = 0;

  for (const lang of targetLanguages) {
    const dirName = toChromeDirName(lang.code);
    const messagesPath = path.join(localesRoot, dirName, 'messages.json');
    const relativeMessagesPath = `_locales/${dirName}/messages.json`;

    if (!fs.existsSync(messagesPath)) {
      log(`  ⚠ Skipping ${lang.code}: messages.json not found`, colors.yellow);
      continue;
    }

    let messages;
    try {
      messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    } catch (error) {
      log(`  ⚠ Skipping ${lang.code}: ${error.message}`, colors.yellow);
      continue;
    }

    const langInfo = getLangInfo(lang);
    let translatedCount = 0;
    let reviewedCount = 0;
    let fileModified = false;

    // --- Part 0: Validate and fix manifest keys (extension_name) ---
    const manifestCheck = validateManifestKeys(messages);
    if (manifestCheck.fixed) {
      fileModified = true;
      for (const issue of manifestCheck.issues) {
        log(`  🔧 ${lang.code}: Fixed ${issue}`, colors.yellow);
      }
    }

    // --- Part 1: Translate missing keys ---
    // Get keys with empty translations and their original text
    // Skip keys that should not be translated (brand names, etc.)
    const emptyEntries = Object.entries(messages)
      .filter(([key, value]) => (!value.message || value.message === '') && !CONFIG.skipKeys.includes(key))
      .map(([key, _]) => ({
        key,
        // Use original text from key_map or en/messages.json, fallback to key if not found
        originalText: getOriginalText(key, keyToText, enMessages),
      }));

    if (emptyEntries.length > 0) {
      log(`\n  📝 ${lang.code}: ${emptyEntries.length} keys need translation...`, colors.cyan);

      for (let i = 0; i < emptyEntries.length; i += CONFIG.batchSize) {
        const batch = emptyEntries.slice(i, i + CONFIG.batchSize);
        const batchNum = Math.floor(i / CONFIG.batchSize) + 1;
        const totalBatches = Math.ceil(emptyEntries.length / CONFIG.batchSize);

        log(`    Batch ${batchNum}/${totalBatches} (${batch.length} keys)...`, colors.dim);

        try {
          // Use original texts for translation prompt
          const textsToTranslate = batch.map(entry => entry.originalText);
          const prompt = buildTranslationPrompt(lang.code, langInfo, textsToTranslate);
          const response = await callFireworksAPI(prompt, CONFIG.translationModel);
          const translations = parseJSONResponse(response);

          // Map translations back to keys
          for (const entry of batch) {
            const translation = translations[entry.originalText];
            if (translation) {
              messages[entry.key].message = translation;
              translatedCount++;
              fileModified = true;
            }
          }

          if (i + CONFIG.batchSize < emptyEntries.length) {
            await sleep(CONFIG.delayBetweenCalls);
          }
        } catch (error) {
          log(`    ⚠ Batch ${batchNum} failed: ${error.message}`, colors.yellow);
        }
      }

      if (translatedCount > 0) {
        log(`  ✓ ${lang.code}: ${translatedCount} keys translated`, colors.green);
        totalTranslated += translatedCount;
      }
    }

    // --- Part 2: Review flagged translations from validation report ---
    const flaggedItems = validationReport?.[relativeMessagesPath];
    if (flaggedItems && flaggedItems.length > 0) {
      log(`\n  🔄 ${lang.code}: Reviewing ${flaggedItems.length} flagged translation(s)...`, colors.cyan);

      // Add original text to flagged items
      const flaggedWithText = flaggedItems.map(item => ({
        ...item,
        originalText: getOriginalText(item.key, keyToText, enMessages),
      }));

      for (let i = 0; i < flaggedWithText.length; i += CONFIG.batchSize) {
        const batch = flaggedWithText.slice(i, i + CONFIG.batchSize);
        const batchNum = Math.floor(i / CONFIG.batchSize) + 1;
        const totalBatches = Math.ceil(flaggedWithText.length / CONFIG.batchSize);

        log(`    Review batch ${batchNum}/${totalBatches} (${batch.length} items)...`, colors.dim);

        try {
          const prompt = buildReviewPrompt(lang.code, langInfo, batch);
          const response = await callFireworksAPI(prompt, CONFIG.translationModel);
          const reviewedTranslations = parseJSONResponse(response);

          for (const item of batch) {
            const newTranslation = reviewedTranslations[item.originalText];
            if (newTranslation && newTranslation !== item.translation) {
              messages[item.key].message = newTranslation;
              reviewedCount++;
              fileModified = true;
              log(`      Updated: "${item.originalText.substring(0, 40)}..."`, colors.dim);
            }
          }

          if (i + CONFIG.batchSize < flaggedWithText.length) {
            await sleep(CONFIG.delayBetweenCalls);
          }
        } catch (error) {
          log(`    ⚠ Review batch ${batchNum} failed: ${error.message}`, colors.yellow);
        }
      }

      if (reviewedCount > 0) {
        log(`  ✓ ${lang.code}: ${reviewedCount} translation(s) updated after review`, colors.green);
        totalReviewed += reviewedCount;
      } else {
        log(`  ✓ ${lang.code}: All flagged translations kept as-is`, colors.green);
      }
    }

    // Save if modified
    if (fileModified) {
      fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2) + '\n');
    }

    // Log summary for locales with no work
    if (emptyEntries.length === 0 && !flaggedItems) {
      log(`  ✓ ${lang.code}: All ${Object.keys(messages).length} keys translated`, colors.green);
    }
  }

  // Delete validation report after processing
  if (validationReport && fs.existsSync(reportPath)) {
    fs.unlinkSync(reportPath);
    log(`\n  🗑️  Validation report processed and removed`, colors.dim);
  }

  // Summary
  log(`\n✅ Translation complete!`, colors.green);
  if (totalTranslated > 0) {
    log(`   - ${totalTranslated} new translation(s) added`, colors.reset);
  }
  if (totalReviewed > 0) {
    log(`   - ${totalReviewed} translation(s) updated from review`, colors.reset);
  }
  if (totalTranslated === 0 && totalReviewed === 0) {
    log(`   - No changes needed`, colors.reset);
  }

  if (totalTranslated > 0 || totalReviewed > 0) {
    log('\n📝 Next steps:', colors.cyan);
    log('  1. Review the translations in _locales/*/messages.json', colors.reset);
    log('  2. Run "npm run build" to include translations in the extension', colors.reset);
  }
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Build the validation prompt using original English text
 */
function buildValidationPrompt(targetLang, langInfo, translationsToValidate) {
  const itemsList = translationsToValidate
    .map((item, i) => `${i + 1}. English: "${item.originalText}"\n   ${langInfo.name}: "${item.translation}"`)
    .join('\n\n');

  return `You are a professional translator and quality assurance specialist for software UI localization.

Task: Validate the following ${langInfo.name} (${langInfo.nativeName}) translations of English UI text.

Target Language: ${langInfo.name}
Language Code: ${targetLang}

Validation Criteria:
- Translation accurately conveys the meaning of the English text
- Translation is natural and appropriate for UI context
- CRITICAL: Placeholders like $NAME$, $1$, $2$, etc. MUST be preserved exactly as in the original
  - Flag as INCORRECT if any placeholder is missing, modified, or translated
  - Example: "Hello $NAME$" must have "$NAME$" in the translation (e.g., "你好 $NAME$")
- Technical terms are handled appropriately (kept in English or properly translated)
- No grammatical errors or typos in the translation
- Tone matches the original (formal/informal)
- ${langInfo.instructions}

Translations to validate:
${itemsList}

For each translation, determine if it is CORRECT or INCORRECT.
If INCORRECT, explain the issue and suggest a better translation.

Respond with ONLY a JSON array of issues found. If a translation is correct, do NOT include it.
Format: [{"index": 1, "issue": "description of problem", "suggestion": "better translation"}, ...]

If ALL translations are correct, return an empty array: []

Important: Return ONLY the JSON array, no markdown, no explanation. Use English for all descriptions.`;
}

/**
 * Main validation function
 */
async function validateTranslations() {
  const projectRoot = path.join(__dirname, '..');
  const localesRoot = path.join(projectRoot, '_locales');
  const reportPath = path.join(projectRoot, CONFIG.validationReportPath);

  log('\n🔍 Validating existing i18n translations...', colors.cyan);
  checkApiKey();

  // Load English messages for reference values
  const enMessages = loadEnglishMessages(localesRoot);

  // Load key_map.json for text <-> key mapping
  const { textToKey, keyToText } = loadKeyMap(localesRoot);
  const hasKeyMap = Object.keys(keyToText).length > 0;

  if (!hasKeyMap) {
    log('  ⚠ No key mappings found. Using keys directly for validation.', colors.yellow);
  } else {
    log(`  📄 Loaded ${Object.keys(keyToText).length} key-to-text mappings`, colors.reset);
  }

  const supportedLanguages = loadSupportedLanguages(localesRoot);
  const targetLanguages = supportedLanguages.filter(
    lang => lang.code !== 'en-US' && lang.code !== 'en'
  );

  if (targetLanguages.length === 0) {
    log('  No target languages to validate.', colors.yellow);
    return;
  }

  log(`  Found ${targetLanguages.length} target language(s): ${targetLanguages.map(l => l.code).join(', ')}`, colors.reset);
  log(`  Using validation model: ${CONFIG.validationModel}`, colors.dim);

  // Report structure: { "path/to/file.json": [ {key, translation, description}, ... ] }
  const validationReport = {};
  let totalIssues = 0;

  for (const lang of targetLanguages) {
    const dirName = toChromeDirName(lang.code);
    const messagesPath = path.join(localesRoot, dirName, 'messages.json');
    const relativeMessagesPath = `_locales/${dirName}/messages.json`;

    if (!fs.existsSync(messagesPath)) {
      log(`  ⚠ Skipping ${lang.code}: messages.json not found`, colors.yellow);
      continue;
    }

    let messages;
    try {
      messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    } catch (error) {
      log(`  ⚠ Skipping ${lang.code}: ${error.message}`, colors.yellow);
      continue;
    }

    // --- Validate manifest keys (extension_name) ---
    const manifestCheck = validateManifestKeys(messages);
    if (manifestCheck.issues.length > 0) {
      for (const issue of manifestCheck.issues) {
        log(`  ⚠ ${lang.code}: ${issue}`, colors.yellow);
      }
    }
    if (manifestCheck.fixed) {
      // Save the fixed file
      fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2) + '\n');
      log(`  🔧 ${lang.code}: Fixed manifest keys`, colors.green);
    }

    // Get only keys with non-empty translations, with original text
    // Skip keys that should not be validated (brand names, etc.)
    const translatedEntries = Object.entries(messages)
      .filter(([key, value]) => value.message && value.message !== '' && !CONFIG.skipKeys.includes(key))
      .map(([key, value]) => ({
        key,
        translation: value.message,
        // Use original text from key_map or en/messages.json, fallback to key if not found
        originalText: getOriginalText(key, keyToText, enMessages),
      }));

    if (translatedEntries.length === 0) {
      log(`  ⚠ ${lang.code}: No translations to validate`, colors.yellow);
      continue;
    }

    log(`\n  🔍 ${lang.code}: Validating ${translatedEntries.length} translations...`, colors.cyan);

    const langInfo = getLangInfo(lang);

    const issuesForLocale = [];

    // Process in batches
    for (let i = 0; i < translatedEntries.length; i += CONFIG.batchSize) {
      const batch = translatedEntries.slice(i, i + CONFIG.batchSize);
      const batchNum = Math.floor(i / CONFIG.batchSize) + 1;
      const totalBatches = Math.ceil(translatedEntries.length / CONFIG.batchSize);

      log(`    Batch ${batchNum}/${totalBatches} (${batch.length} translations)...`, colors.dim);

      try {
        const prompt = buildValidationPrompt(lang.code, langInfo, batch);
        const response = await callFireworksAPI(prompt, CONFIG.validationModel);
        const issues = parseJSONResponse(response);

        // Map issues back to original keys
        if (Array.isArray(issues) && issues.length > 0) {
          for (const issue of issues) {
            const idx = issue.index - 1; // Convert 1-based to 0-based
            if (idx >= 0 && idx < batch.length) {
              issuesForLocale.push({
                key: batch[idx].key,
                translation: batch[idx].translation,
                description: `${issue.issue}${issue.suggestion ? ` Suggested translation: "${issue.suggestion}"` : ''}`,
              });
            }
          }
        }

        if (i + CONFIG.batchSize < translatedEntries.length) {
          await sleep(CONFIG.delayBetweenCalls);
        }
      } catch (error) {
        log(`    ⚠ Batch ${batchNum} failed: ${error.message}`, colors.yellow);
      }
    }

    if (issuesForLocale.length > 0) {
      validationReport[relativeMessagesPath] = issuesForLocale;
      totalIssues += issuesForLocale.length;
      log(`  ⚠ ${lang.code}: Found ${issuesForLocale.length} issue(s)`, colors.yellow);
    } else {
      log(`  ✓ ${lang.code}: All translations valid`, colors.green);
    }
  }

  // Write validation report
  if (totalIssues > 0) {
    fs.writeFileSync(reportPath, JSON.stringify(validationReport, null, 2) + '\n');
    log(`\n⚠️  Validation complete! Found ${totalIssues} issue(s).`, colors.yellow);
    log(`\n📄 Report saved to: ${CONFIG.validationReportPath}`, colors.cyan);
    log('\n📝 Next steps:', colors.cyan);
    log('  1. Review the validation report', colors.reset);
    log('  2. Manually fix translations in _locales/*/messages.json', colors.reset);
    log('  3. Run validation again to confirm fixes', colors.reset);
  } else {
    // Remove old report if exists and no issues found
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }
    log(`\n✅ Validation complete! All translations are valid.`, colors.green);
  }

  return { totalIssues, report: validationReport };
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

const command = process.argv[2];

if (require.main === module) {
  if (command === 'validate') {
    validateTranslations().catch(error => {
      log(`\n❌ Error: ${error.message}`, colors.red);
      process.exit(1);
    });
  } else {
    // Default: translate
    translateMissing().catch(error => {
      log(`\n❌ Error: ${error.message}`, colors.red);
      process.exit(1);
    });
  }
}

module.exports = { translateMissing, validateTranslations };
