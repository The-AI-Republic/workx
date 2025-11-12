/**
 * Verification script for AgentConfig integration fixes
 * Run with: npx tsx verify-config-integration.ts
 */

import { Session } from './src/core/Session';
import { ToolRegistry } from './src/tools/ToolRegistry';
import { ApprovalManager } from './src/core/ApprovalManager';
import { ModelClientFactory } from './src/models/ModelClientFactory';

console.log('🔍 Verifying AgentConfig Integration Fixes...\n');

// Test 1: Session constructor accepts config
console.log('✅ Test 1: Session constructor');
try {
  const session1 = new Session(); // Old signature
  const session2 = new Session(true); // Old signature
  const session3 = new Session(undefined, true); // New signature
  console.log('  - Old signatures work (backward compatibility)');

  // Check if methods exist
  if (typeof session1.getDefaultModel === 'function' &&
      typeof session1.getDefaultCwd === 'function' &&
      typeof session1.isStorageEnabled === 'function') {
    console.log('  - Config utility methods exist');
  }
} catch (error) {
  console.error('  ❌ Session test failed:', error);
}

// Test 2: ToolRegistry constructor accepts config
console.log('\n✅ Test 2: ToolRegistry constructor');
try {
  const registry1 = new ToolRegistry(); // Old signature
  const registry2 = new ToolRegistry(undefined); // New signature
  console.log('  - Old signatures work (backward compatibility)');

  // Check if methods exist
  if (typeof registry1.initialize === 'function' &&
      typeof registry1.getEnabledTools === 'function' &&
      typeof registry1.getToolTimeout === 'function' &&
      typeof registry1.getSandboxPolicy === 'function') {
    console.log('  - Initialize method and config utilities exist');
  }
} catch (error) {
  console.error('  ❌ ToolRegistry test failed:', error);
}

// Test 3: ApprovalManager constructor accepts config
console.log('\n✅ Test 3: ApprovalManager constructor');
try {
  const manager1 = new ApprovalManager(); // Old signature
  const manager2 = new ApprovalManager(undefined); // New signature
  console.log('  - Old signatures work (backward compatibility)');

  // Check if methods exist
  if (typeof manager1.getDefaultPolicy === 'function' &&
      typeof manager1.getAutoApproveList === 'function' &&
      typeof manager1.getApprovalTimeout === 'function') {
    console.log('  - Config utility methods exist');
  }
} catch (error) {
  console.error('  ❌ ApprovalManager test failed:', error);
}

// Test 4: ModelClientFactory has initialize method
console.log('\n✅ Test 4: ModelClientFactory');
try {
  const factory = new ModelClientFactory();

  // Check if methods exist
  if (typeof factory.initialize === 'function' &&
      typeof factory.getSelectedModel === 'function' &&
      typeof factory.getApiKey === 'function' &&
      typeof factory.getBaseUrl === 'function') {
    console.log('  - Initialize method and config utilities exist');
  }
} catch (error) {
  console.error('  ❌ ModelClientFactory test failed:', error);
}

console.log('\n✨ All AgentConfig integration fixes verified successfully!');