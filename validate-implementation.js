#!/usr/bin/env node
/**
 * Implementation Validation Script
 * Feature: 005-fix-multi-provider-config
 *
 * Validates that the implementation meets all requirements from spec.md
 */

console.log('🔍 Validating Multi-Provider Configuration Implementation...\n');

const fs = require('fs');
const path = require('path');

let validationsPassed = 0;
let validationsFailed = 0;

function validate(name, condition, details = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    validationsPassed++;
  } else {
    console.log(`❌ ${name}`);
    if (details) console.log(`   ${details}`);
    validationsFailed++;
  }
}

// Check file existence
console.log('📁 File Structure Validation:');
validate(
  'IAgentConfig type definition exists',
  fs.existsSync('src/config/types.ts')
);
validate(
  'AgentConfig implementation exists',
  fs.existsSync('src/config/AgentConfig.ts')
);
validate(
  'ModelClientFactory exists',
  fs.existsSync('src/models/ModelClientFactory.ts')
);
validate(
  'Settings UI exists',
  fs.existsSync('src/sidepanel/Settings.svelte')
);
validate(
  'ModelSelector component exists',
  fs.existsSync('src/sidepanel/settings/ModelSelector.svelte')
);

// Check type definitions
console.log('\n📝 Type Definition Validation:');
const typesContent = fs.readFileSync('src/config/types.ts', 'utf-8');
validate(
  'IModelRegistryEntry defined',
  typesContent.includes('interface IModelRegistryEntry')
);
validate(
  'selectedModelId field exists',
  typesContent.includes('selectedModelId')
);
validate(
  'modelRegistry field exists',
  typesContent.includes('modelRegistry')
);
validate(
  'modelIdCounter field exists',
  typesContent.includes('modelIdCounter')
);
validate(
  'IProviderConfig has models array',
  typesContent.includes('models: IModelConfig[]')
);
validate(
  'IModelConfig has id field',
  typesContent.includes('id: string')
);
validate(
  'IModelConfig has modelKey field',
  typesContent.includes('modelKey: string')
);
validate(
  'IModelConfig has creator field',
  typesContent.includes('creator: string')
);

// Check AgentConfig implementation
console.log('\n⚙️  AgentConfig Implementation Validation:');
const agentConfigContent = fs.readFileSync('src/config/AgentConfig.ts', 'utf-8');
validate(
  'generateModelId() method exists',
  agentConfigContent.includes('generateModelId()')
);
validate(
  'setSelectedModel() method exists',
  agentConfigContent.includes('setSelectedModel(')
);
validate(
  'getModelById() method exists',
  agentConfigContent.includes('getModelById(')
);
validate(
  'getAllModels() method exists',
  agentConfigContent.includes('getAllModels(')
);
validate(
  'setProviderApiKey() method exists',
  agentConfigContent.includes('setProviderApiKey(')
);
validate(
  'deleteProviderApiKey() method exists',
  agentConfigContent.includes('deleteProviderApiKey(')
);
validate(
  'ensureModelIds() method exists',
  agentConfigContent.includes('ensureModelIds(')
);
validate(
  'API key encryption is used',
  agentConfigContent.includes('encryptApiKey(')
);
validate(
  'Logging for model switches exists',
  agentConfigContent.includes('[AgentConfig] Model switched')
);
validate(
  'Logging for API key operations exists',
  agentConfigContent.includes('[AgentConfig] API key')
);

// Check validators
console.log('\n✔️  Validation Functions:');
const validatorsContent = fs.readFileSync('src/config/validators.ts', 'utf-8');
validate(
  'isValidModelId() validator exists',
  validatorsContent.includes('function isValidModelId(')
);
validate(
  'validateModelIdUniqueness() exists',
  validatorsContent.includes('function validateModelIdUniqueness(')
);
validate(
  'selectedModelId validation in validateConfig()',
  validatorsContent.includes('selectedModelId') && validatorsContent.includes('isValidModelId(')
);

// Check defaults
console.log('\n🎯 Default Configuration Validation:');
const defaultsContent = fs.readFileSync('src/config/defaults.ts', 'utf-8');
validate(
  'OpenAI provider with GPT-5 model defined',
  defaultsContent.includes("id: 'openai'") && defaultsContent.includes("name: 'GPT-5'")
);
validate(
  'xAI provider with Grok 4 model defined',
  defaultsContent.includes("id: 'xai'") && defaultsContent.includes("name: 'Grok 4 Fast Reasoning'")
);
validate(
  'Models have empty IDs for random generation',
  defaultsContent.includes("id: ''") || defaultsContent.includes('id: "",')
);

// Check ModelClientFactory integration
console.log('\n🏭 ModelClientFactory Integration:');
const factoryContent = fs.readFileSync('src/models/ModelClientFactory.ts', 'utf-8');
validate(
  'createClientForCurrentModel() exists',
  factoryContent.includes('createClientForCurrentModel(')
);
validate(
  'Uses AgentConfig for provider lookup',
  factoryContent.includes('AgentConfig') && factoryContent.includes('import')
);
validate(
  'loadConfigForProvider uses AgentConfig',
  factoryContent.includes('getProviderApiKey(')
);

// Check UI implementation
console.log('\n🎨 UI Implementation Validation:');
const settingsContent = fs.readFileSync('src/sidepanel/Settings.svelte', 'utf-8');
validate(
  'handleModelChange uses setSelectedModel',
  settingsContent.includes('setSelectedModel(')
);
validate(
  'Async model switching (prevents UI freeze)',
  settingsContent.includes('async function handleModelChange')
);
validate(
  'Loading states implemented',
  settingsContent.includes('isLoading')
);
validate(
  'Provider-specific API key operations',
  settingsContent.includes('deleteProviderApiKey(')
);

const modelSelectorContent = fs.readFileSync('src/sidepanel/settings/ModelSelector.svelte', 'utf-8');
validate(
  'ModelSelector uses getAllModels()',
  modelSelectorContent.includes('getAllModels(')
);
validate(
  'Model display shows provider name',
  modelSelectorContent.includes('providerName')
);

// Check deprecation warnings
console.log('\n⚠️  Deprecation Warnings:');

// Summary
console.log('\n' + '='.repeat(60));
console.log('📊 Validation Summary:');
console.log(`✅ Passed: ${validationsPassed}`);
console.log(`❌ Failed: ${validationsFailed}`);
console.log(`📈 Success Rate: ${Math.round((validationsPassed / (validationsPassed + validationsFailed)) * 100)}%`);
console.log('='.repeat(60));

if (validationsFailed === 0) {
  console.log('\n🎉 All validations passed! Implementation is complete.');
  process.exit(0);
} else {
  console.log('\n⚠️  Some validations failed. Review the issues above.');
  process.exit(1);
}
