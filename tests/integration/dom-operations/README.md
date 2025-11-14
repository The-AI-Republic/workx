# DOM Operations Integration Tests

This directory contains comprehensive integration tests for DOM operations in the Browserx Chrome Extension, implementing test scenarios T018-T022 based on the quickstart guide.

## Test Files

### form_automation.test.ts
Tests form filling and submission flow including:
- Complete form workflows with validation
- Individual field interactions (typing, focusing, scrolling)
- Form submission with various options
- Error handling for form operations
- Multi-step form processes

### wait_for_element.test.ts
Tests element visibility and waiting functionality including:
- Waiting for elements to appear in the DOM
- Waiting for elements to become visible
- Dynamic content loading scenarios
- AJAX content handling
- Timeout and error conditions

### action_sequence.test.ts
Tests executing sequences of actions including:
- Basic action sequences and workflows
- Complex multi-step navigation flows
- Performance optimization with batch operations
- Conditional action sequences
- Error recovery in sequences

### iframe_access.test.ts
Tests accessing elements in iframes including:
- Same-origin iframe access
- Cross-origin iframe limitations
- Nested iframe hierarchies
- Frame-specific operations (scroll, form filling)
- Security restrictions and error handling

### error_retry.test.ts
Tests error handling and retry logic including:
- Common DOM error scenarios (not found, not visible, timeout)
- Retry logic implementation with exponential backoff
- Content script communication errors
- Network and loading errors
- Complex error recovery patterns (circuit breaker, cascading failures)

## Running the Tests

### Run all DOM operation integration tests:
```bash
npx vitest --config vitest.config.dom.ts tests/integration/dom-operations/
```

### Run specific test file:
```bash
npx vitest --config vitest.config.dom.ts tests/integration/dom-operations/form_automation.test.ts
```

### Run with verbose output:
```bash
npx vitest --config vitest.config.dom.ts --reporter=verbose tests/integration/dom-operations/
```

## Test Features

### Chrome Extension Environment Mocking
- Complete Chrome APIs mocking (tabs, scripting, permissions, runtime)
- Content script injection simulation
- Tab communication simulation

### Real-world Scenarios
- Based on quickstart guide examples
- Full end-to-end workflow testing
- Comprehensive error condition coverage
- Performance and optimization testing

### Test Structure
Each test file follows the pattern:
1. **Setup**: Mock Chrome environment and DOMTool instance
2. **Scenarios**: Test real-world use cases from quickstart guide
3. **Error Handling**: Test various failure modes and recovery
4. **Edge Cases**: Test boundary conditions and timing issues

### Mock Data
Tests use realistic mock DOM elements including:
- Forms with validation
- Dynamic content elements
- Iframe structures
- Loading states and transitions

## Notes

- Tests use jsdom environment for DOM simulation
- All Chrome extension APIs are comprehensively mocked
- Tests verify both success and failure scenarios
- Integration tests focus on end-to-end functionality rather than unit testing
- Tests include timing considerations for async operations