import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoogleCompletionClient } from '../core/models/client/GoogleCompletionClient';
import type { ModelProviderInfo, Prompt } from '../core/models/types/ResponsesAPI';
import { GoogleGenAI } from '@google/genai';

const mocks = vi.hoisted(() => {
    const generateContentStream = vi.fn();
    const models = { generateContentStream };
    const GoogleGenAI = vi.fn().mockImplementation(() => ({ models }));
    return {
        GoogleGenAI,
        models,
        generateContentStream
    };
});

// Mock @google/genai
vi.mock('@google/genai', () => {
    return {
        GoogleGenAI: mocks.GoogleGenAI
    };
});

describe('GoogleCompletionClient', () => {
    let client: GoogleCompletionClient;

    const mockConfig = {
        apiKey: 'test-api-key',
        provider: {
            name: 'google-ai-studio',
            wire_api: 'Responses',
            requires_openai_auth: false
        } as ModelProviderInfo,
        modelFamily: {
            family: 'gemini-2.0-flash-exp',
            base_instructions: 'You are Gemini.',
            supports_reasoning: false,
            supports_reasoning_summaries: false,
            needs_special_apply_patch_instructions: false
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset default mock implementation
        mocks.generateContentStream.mockReset();

        // Re-setup the mock chain
        // mocks.models is already defined in hoisted, we just need to ensure the client returns it
        // and generateContentStream is attached to it.
        // Since models is a const object in hoisted, we can't reassign it, but we can reset the spy on generateContentStream.

        // Ensure the client constructor returns the object with models
        mocks.GoogleGenAI.mockImplementation(() => ({ models: mocks.models }));

        client = new GoogleCompletionClient(mockConfig);
    });

    it('should initialize with correct config', () => {
        expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
        expect(client.getProvider().name).toBe('google-ai-studio');
        expect(client.getModel()).toBe('gemini-2.0-flash-exp');
    });

    it('should stream text content correctly', async () => {
        const prompt: Prompt = {
            input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
            tools: []
        };

        // Mock stream response
        const mockStream = (async function* () {
            yield {
                candidates: [{
                    content: {
                        parts: [{ text: 'Hello ' }]
                    }
                }]
            };
            yield {
                candidates: [{
                    content: {
                        parts: [{ text: 'World' }]
                    }
                }]
            };
            yield {
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 5,
                    totalTokenCount: 15
                }
            };
        })();

        mocks.generateContentStream.mockResolvedValue(mockStream);

        const responseStream = await client.stream(prompt);
        const events: any[] = [];

        // Read from the stream
        // ResponseStream doesn't expose getReader() directly if it's not a ReadableStream itself, 
        // but it has an async iterator or we can consume it via its public API.
        // Wait, ResponseStream in this codebase wraps a ReadableStream?
        // Let's check ResponseStream.ts.
        // Usually it implements AsyncIterable.

        for await (const event of responseStream) {
            events.push(event);
        }

        // Verify events
        expect(events).toHaveLength(4); // 2 text deltas + 1 OutputItemDone + 1 Completed
        expect(events[0]).toEqual({ type: 'OutputTextDelta', delta: 'Hello ' });
        expect(events[1]).toEqual({ type: 'OutputTextDelta', delta: 'World' });
        expect(events[2]).toEqual({
            type: 'OutputItemDone',
            item: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello World' }]
            }
        });
        expect(events[3]).toEqual({
            type: 'Completed',
            responseId: 'gemini-response',
            tokenUsage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0
            }
        });
    });

    it('should handle tool calls correctly', async () => {
        const prompt: Prompt = {
            input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Use tool' }] }],
            tools: [{
                type: 'function',
                function: {
                    name: 'test_tool',
                    description: 'A test tool',
                    strict: false,
                    parameters: { type: 'object', properties: {} }
                }
            }]
        };

        // Mock stream response with tool call
        const mockStream = (async function* () {
            yield {
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                id: 'call_123',
                                name: 'test_tool',
                                args: { param: 'value' }
                            }
                        }]
                    }
                }]
            };
        })();

        mocks.generateContentStream.mockResolvedValue(mockStream);

        const responseStream = await client.stream(prompt);
        const events: any[] = [];

        for await (const event of responseStream) {
            events.push(event);
        }

        // Verify events
        expect(events).toHaveLength(2); // 1 OutputItemDone + 1 Completed
        expect(events[0]).toEqual({
            type: 'OutputItemDone',
            item: {
                type: 'message',
                role: 'assistant',
                content: [],
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: '{"param":"value"}'
                    }
                }]
            }
        });
    });

    it('should map prompt to contents correctly', async () => {
        const prompt: Prompt = {
            input: [
                { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
                { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
            ],
            tools: []
        };

        const mockStream = (async function* () { })();
        mocks.generateContentStream.mockResolvedValue(mockStream);

        const stream = await client.stream(prompt);
        // Consume stream to ensure async task runs
        for await (const _ of stream) { }

        expect(mocks.generateContentStream).toHaveBeenCalledWith(expect.objectContaining({
            contents: [
                { role: 'user', parts: [{ text: 'Hello' }] },
                { role: 'model', parts: [{ text: 'Hi' }] }
            ]
        }));
    });

    it('should sanitize tool schemas', async () => {
        const prompt: Prompt = {
            input: [],
            tools: [{
                type: 'function',
                function: {
                    name: 'test_tool',
                    description: 'A test tool',
                    strict: false,
                    parameters: {
                        type: 'object',
                        // Missing properties, should be added by sanitizer
                    } as any
                }
            }]
        };

        const mockStream = (async function* () { })();
        mocks.generateContentStream.mockResolvedValue(mockStream);

        const stream = await client.stream(prompt);
        // Consume stream to ensure async task runs
        for await (const _ of stream) { }

        const callArgs = mocks.generateContentStream.mock.calls[0][0];
        const tools = callArgs.config.tools[0].functionDeclarations;

        expect(tools[0].parameters).toEqual({
            type: 'object',
            properties: {},
            additionalProperties: true
        });
    });

    it('should retry on rate limit error', async () => {
        const prompt: Prompt = {
            input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
            tools: []
        };

        const errorResponse = {
            message: JSON.stringify({
                error: {
                    code: 429,
                    message: 'Rate limit exceeded',
                    status: 'RESOURCE_EXHAUSTED',
                    details: [{ retryDelay: '0.1s' }]
                }
            })
        };

        const successStream = (async function* () {
            yield {
                candidates: [{
                    content: {
                        parts: [{ text: 'Success' }]
                    }
                }]
            };
        })();

        // Mock first call to fail, second to succeed
        mocks.generateContentStream
            .mockRejectedValueOnce(errorResponse)
            .mockResolvedValueOnce(successStream);

        const stream = await client.stream(prompt);
        const events: any[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
        expect(events).toContainEqual({ type: 'OutputTextDelta', delta: 'Success' });
    });

    it('should include text content (thought) with tool calls', async () => {
        const prompt: Prompt = {
            input: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'I will use the tool.' }],
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'test_tool', arguments: '{}' }
                }]
            }],
            tools: []
        };

        // Mock generateContentStream to capture the arguments
        const mockGenerate = mocks.generateContentStream.mockResolvedValue((async function* () { })());

        const stream = await client.stream(prompt);

        // Consume the stream to ensure the async task runs
        for await (const _ of stream) { }

        // Check if mock was called
        expect(mocks.generateContentStream).toHaveBeenCalled();

        const callArgs = mocks.generateContentStream.mock.calls[0][0];
        const contents = callArgs.contents;

        expect(contents).toHaveLength(1);
        expect(contents[0].role).toBe('model');
        expect(contents[0].parts).toHaveLength(2);
        expect(contents[0].parts[0]).toEqual({ text: 'I will use the tool.' });
        expect(contents[0].parts[1]).toEqual({
            functionCall: {
                name: 'test_tool',
                args: {}
            }
        });
    });

    it('should capture thoughtSignature from tool call responses', async () => {
        const prompt: Prompt = {
            input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Use tool' }] }],
            tools: [{
                type: 'function',
                function: {
                    name: 'test_tool',
                    description: 'A test tool',
                    strict: false,
                    parameters: { type: 'object', properties: {} }
                }
            }]
        };

        // Mock stream response with tool call and thoughtSignature (Gemini 3.0+ format)
        const mockStream = (async function* () {
            yield {
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                id: 'call_123',
                                name: 'test_tool',
                                args: { param: 'value' }
                            },
                            thoughtSignature: 'encrypted_thought_abc123'
                        }]
                    }
                }]
            };
        })();

        mocks.generateContentStream.mockResolvedValue(mockStream);

        const responseStream = await client.stream(prompt);
        const events: any[] = [];

        for await (const event of responseStream) {
            events.push(event);
        }

        // Verify thoughtSignature is captured in tool_calls
        expect(events[0]).toEqual({
            type: 'OutputItemDone',
            item: {
                type: 'message',
                role: 'assistant',
                content: [],
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: '{"param":"value"}'
                    },
                    thoughtSignature: 'encrypted_thought_abc123'
                }]
            }
        });
    });

    it('should pass back thoughtSignature when mapping history with tool calls', async () => {
        const prompt: Prompt = {
            input: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'I will use the tool.' }],
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'test_tool', arguments: '{}' },
                    thoughtSignature: 'encrypted_thought_xyz789'
                }]
            }],
            tools: []
        };

        mocks.generateContentStream.mockResolvedValue((async function* () { })());

        const stream = await client.stream(prompt);
        for await (const _ of stream) { }

        expect(mocks.generateContentStream).toHaveBeenCalled();

        const callArgs = mocks.generateContentStream.mock.calls[0][0];
        const contents = callArgs.contents;

        expect(contents).toHaveLength(1);
        expect(contents[0].role).toBe('model');
        expect(contents[0].parts).toHaveLength(2);
        expect(contents[0].parts[0]).toEqual({ text: 'I will use the tool.' });
        expect(contents[0].parts[1]).toEqual({
            functionCall: {
                name: 'test_tool',
                args: {}
            },
            thoughtSignature: 'encrypted_thought_xyz789'
        });
    });
    it('should use custom fetch with credentials: "include" when useCredentials is true', async () => {
        const configWithCreds = {
            ...mockConfig,
            useCredentials: true,
            baseUrl: 'https://api.airepublic.com/gemini'
        };

        const clientWithCreds = new GoogleCompletionClient(configWithCreds);

        // Verify GoogleGenAI constructor call
        expect(GoogleGenAI).toHaveBeenCalledWith(expect.objectContaining({
            httpOptions: expect.objectContaining({
                baseUrl: 'https://api.airepublic.com/gemini'
            })
        }));

        // Get the options passed to GoogleGenAI
        const options = mocks.GoogleGenAI.mock.calls[mocks.GoogleGenAI.mock.calls.length - 1][0];
        const fetchFn = options.httpOptions.fetch;
        expect(fetchFn).toBeDefined();

        // Mock global fetch
        const mockFetch = vi.fn().mockResolvedValue(new Response('{}'));
        globalThis.fetch = mockFetch;

        // Call the custom fetch function
        await fetchFn('https://test.url', { method: 'GET' });

        // Verify it was called with credentials: 'include'
        expect(mockFetch).toHaveBeenCalledWith('https://test.url', expect.objectContaining({
            credentials: 'include'
        }));
    });
});
