import { GoogleCompletionClient } from '../models/client/GoogleCompletionClient';
import { OpenAIChatCompletionConfig } from '../models/client/OpenAIChatCompletionClient';

describe('GoogleCompletionClient', () => {
    let client: GoogleCompletionClient;

    beforeEach(() => {
        const config: OpenAIChatCompletionConfig = {
            apiKey: 'test-key',
            baseUrl: 'https://test.url',
            provider: {
                name: 'Google',
                base_url: 'https://test.url',
                wire_api: 'Responses',
                requires_openai_auth: false
            },
            modelFamily: {
                family: 'gemini',
                base_instructions: 'test',
                supports_reasoning: false,
                supports_reasoning_summaries: false,
                needs_special_apply_patch_instructions: false
            }
        };
        client = new GoogleCompletionClient(config);
    });

    describe('sanitizeSchema', () => {
        it('should add properties: {} and additionalProperties: true to object schema without properties', () => {
            const schema = {
                type: 'object',
                description: 'Test object'
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized).toEqual({
                type: 'object',
                description: 'Test object',
                properties: {},
                additionalProperties: true
            });
        });

        it('should preserve existing properties', () => {
            const schema = {
                type: 'object',
                properties: {
                    foo: { type: 'string' }
                }
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized).toEqual({
                type: 'object',
                properties: {
                    foo: { type: 'string' }
                },
                additionalProperties: false
            });
        });

        it('should recursively sanitize nested objects', () => {
            const schema = {
                type: 'object',
                properties: {
                    nested: {
                        type: 'object',
                        description: 'Nested object'
                    }
                }
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized).toEqual({
                type: 'object',
                properties: {
                    nested: {
                        type: 'object',
                        properties: {},
                        additionalProperties: true,
                        description: 'Nested object'
                    }
                },
                additionalProperties: false
            });
        });

        it('should sanitize array items', () => {
            const schema = {
                type: 'array',
                items: {
                    type: 'object',
                    description: 'Array item'
                }
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized).toEqual({
                type: 'array',
                items: {
                    type: 'object',
                    description: 'Array item',
                    properties: {},
                    additionalProperties: true
                }
            });
        });

        it('should remove title field', () => {
            const schema = {
                type: 'string',
                title: 'Some Title'
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized).toEqual({
                type: 'string'
            });
        });

        it('should truncate long descriptions', () => {
            const longDesc = 'a'.repeat(2000);
            const schema = {
                type: 'string',
                description: longDesc
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized.description.length).toBe(1024);
            expect(sanitized.description.endsWith('...')).toBe(true);
        });

        it('should handle non-object schemas', () => {
            const schema = {
                type: 'string'
            };

            const sanitized = (client as any).sanitizeSchema(schema);

            expect(sanitized).toEqual(schema);
        });
    });

    describe('makeChatCompletionsRequest (Overflow Strategy)', () => {
        it('should move long tool descriptions to system prompt and truncate in tool definition', async () => {
            const longDesc = 'a'.repeat(2000);
            const prompt = {
                instructions: 'Base instructions',
                tools: [{
                    type: 'function',
                    function: {
                        name: 'long_tool',
                        description: longDesc,
                        parameters: { type: 'object', properties: {} }
                    }
                }],
                input: []
            };

            // Mock the OpenAI client's create method
            let capturedParams: any = null;
            (client as any).client = {
                chat: {
                    completions: {
                        create: async (params: any) => {
                            capturedParams = params;
                            return {
                                [Symbol.asyncIterator]: async function* () {
                                    yield { choices: [{ delta: { content: 'response' } }] };
                                }
                            };
                        }
                    }
                }
            };

            // Call the protected method
            await (client as any).makeChatCompletionsRequest(prompt);

            expect(capturedParams).toBeDefined();

            // Verify tool description is truncated
            const tool = capturedParams.tools[0];
            expect(tool.function.description.length).toBeLessThan(1025);
            expect(tool.function.description.endsWith('...')).toBe(true);

            // Verify system prompt contains the full description
            // The system message might be constructed from base instructions + prompt instructions + supplemental
            // We check if the content contains our supplemental instruction marker
            const systemMessage = capturedParams.messages.find((m: any) => m.role === 'system');
            expect(systemMessage).toBeDefined();
            expect(systemMessage.content).toContain('### Tool Instructions: long_tool');
            expect(systemMessage.content).toContain(longDesc);
        });

        it('should stringify non-string tool outputs', async () => {
            const prompt = {
                instructions: 'Base instructions',
                tools: [],
                input: [{
                    type: 'function_call_output',
                    call_id: 'call_123',
                    output: { result: 'success', data: [1, 2, 3] }
                }]
            };

            // Mock the OpenAI client's create method
            let capturedParams: any = null;
            (client as any).client = {
                chat: {
                    completions: {
                        create: async (params: any) => {
                            capturedParams = params;
                            return {
                                [Symbol.asyncIterator]: async function* () {
                                    yield { choices: [{ delta: { content: 'response' } }] };
                                }
                            };
                        }
                    }
                }
            };

            // Call the protected method
            await (client as any).makeChatCompletionsRequest(prompt);

            expect(capturedParams).toBeDefined();
            const toolMessage = capturedParams.messages.find((m: any) => m.role === 'tool');
            expect(toolMessage).toBeDefined();
            expect(typeof toolMessage.content).toBe('string');
            expect(toolMessage.content).toBe(JSON.stringify({ result: 'success', data: [1, 2, 3] }));
        });

        it('should correctly sanitize PlanningTool schema', () => {
            const planningSchema = {
                type: 'object',
                properties: {
                    explanation: {
                        type: 'string',
                        description: 'Optional explanation for plan creation/update'
                    },
                    plan: {
                        type: 'array',
                        description: 'Ordered list of plan steps',
                        items: {
                            type: 'object',
                            properties: {
                                step: { type: 'string', description: 'Step description' },
                                status: {
                                    type: 'string',
                                    enum: ['Pending', 'InProgress', 'Completed'],
                                    description: 'Step status'
                                }
                            },
                            required: ['step', 'status']
                        }
                    }
                },
                required: ['plan']
            };

            const sanitized = (client as any).sanitizeSchema(planningSchema);

            // Verify structure is preserved
            expect(sanitized.type).toBe('object');
            expect(sanitized.properties.plan).toBeDefined();
            expect(sanitized.properties.plan.type).toBe('array');
            expect(sanitized.properties.plan.items).toBeDefined();
            expect(sanitized.properties.plan.items.type).toBe('object');
            expect(sanitized.properties.plan.items.properties).toBeDefined();
            expect(sanitized.properties.plan.items.properties.step).toBeDefined();
            expect(sanitized.properties.plan.items.properties.status).toBeDefined();

            // Verify additionalProperties is added/set
            expect(sanitized.additionalProperties).toBe(false); // Root object (has properties)
            expect(sanitized.properties.plan.items.additionalProperties).toBe(false); // Nested item object (has properties)
        });
    });
});
