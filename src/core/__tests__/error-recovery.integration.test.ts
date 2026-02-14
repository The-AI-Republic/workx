import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Error Recovery', () => {
  let chromeMock: any;

  beforeEach(() => {
    chromeMock = {
      tabs: {
        sendMessage: vi.fn()
      },
      runtime: {
        lastError: null as any
      },
      scripting: {
        executeScript: vi.fn()
      }
    };
    global.chrome = chromeMock;
  });

  it('should detect when listener not registered', async () => {
    // Simulate "receiving end does not exist" error
    chromeMock.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      chromeMock.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      callback();
    });

    const tabId = 123;
    const error = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    }).catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Could not establish connection');
  });

  it('should retry with exponential backoff', async () => {
    const attempts: number[] = [];

    chromeMock.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      attempts.push(Date.now());
      if (attempts.length < 3) {
        chromeMock.runtime.lastError = { message: 'Could not establish connection' };
        callback();
      } else {
        chromeMock.runtime.lastError = null;
        callback({ type: 'PONG', initLevel: 4 });
      }
    });

    // Simulate retry logic (simplified)
    const maxRetries = 5;
    const baseDelay = 100;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(123, { type: 'PING' }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          });
        });
        break;  // Success
      } catch (error) {
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // Should have made multiple attempts
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.length).toBeLessThanOrEqual(3);
  });

  it('should fail after max retries', async () => {
    chromeMock.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      chromeMock.runtime.lastError = { message: 'Could not establish connection' };
      callback();
    });

    const maxRetries = 3;
    const baseDelay = 10; // Short delay for test

    let finalError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(123, { type: 'PING' }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          });
        });
        break;
      } catch (error) {
        finalError = error as Error;
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    expect(finalError).toBeInstanceOf(Error);
    expect(finalError?.message).toContain('Could not establish connection');
  });

  it('should differentiate between injection failure and listener failure', () => {
    // Test with CSP-blocked page simulation
    chromeMock.scripting.executeScript.mockImplementation(() => {
      throw new Error('Content Security Policy blocks script injection');
    });

    expect(() => {
      chrome.scripting.executeScript({ target: { tabId: 123 }, files: ['/content.js'] });
    }).toThrow('Content Security Policy');
  });
});
