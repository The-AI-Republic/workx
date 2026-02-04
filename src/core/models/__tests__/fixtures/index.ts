/**
 * Test fixtures for model tests
 */

// Mock API responses
export const mockApiResponse = {
  id: 'chatcmpl-test-123',
  object: 'chat.completion',
  created: 1699999999,
  model: 'gpt-4',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'Test response from API',
    },
    finish_reason: 'stop',
  }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  },
};

// Mock streaming API response
export const mockStreamResponse = {
  id: 'chatcmpl-test-stream-123',
  object: 'chat.completion.chunk',
  created: 1699999999,
  model: 'gpt-4',
  choices: [{
    index: 0,
    delta: {
      content: 'Streaming response chunk',
    },
    finish_reason: null,
  }],
};

// Mock API configuration
export const mockApiConfig = {
  apiKey: 'test-api-key-12345',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-4',
  temperature: 0.7,
  maxTokens: 1000,
};

// Mock Anthropic API response
export const mockAnthropicResponse = {
  id: 'msg-test-123',
  type: 'message',
  role: 'assistant',
  content: [{
    type: 'text',
    text: 'Test response from Anthropic API',
  }],
  model: 'claude-3-opus-20240229',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
  },
};

// Mock client configuration
export const mockClientConfig = {
  provider: 'openai' as const,
  apiKey: 'test-key',
  model: 'gpt-4',
  maxTokens: 1000,
  temperature: 0.7,
};

// Mock error responses
export const mockApiError = {
  error: {
    message: 'Invalid API key',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
};

export const mockNetworkError = new Error('Network request failed');

// Mock conversation messages
export const mockMessages = [
  {
    role: 'user' as const,
    content: 'Hello, how can you help me?',
  },
  {
    role: 'assistant' as const,
    content: 'I can help you with various tasks. What would you like to know?',
  },
];

// Mock model capabilities
export const mockModelCapabilities = {
  supportsStreaming: true,
  supportsFunctionCalling: true,
  maxTokens: 4000,
  contextWindow: 8000,
};