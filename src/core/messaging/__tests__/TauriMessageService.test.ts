/**
 * Unit Tests: TauriMessageService – CONFIG_UPDATE routing
 *
 * Verifies that the send() method correctly routes CONFIG_UPDATE messages
 * to DesktopAgentBootstrap.handleConfigUpdate() and returns appropriate
 * success/failure responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBootstrap = {
  handleConfigUpdate: vi.fn().mockResolvedValue(undefined),
  getReadyState: vi.fn().mockResolvedValue({ ready: true, message: 'OK', authMode: 'api_key' }),
  getAgent: vi.fn().mockReturnValue(null),
  getSkillRegistry: vi.fn().mockReturnValue(null),
};

vi.mock('@/desktop/agent/DesktopAgentBootstrap', () => ({
  getDesktopAgentBootstrap: vi.fn(() => mockBootstrap),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@/desktop/channels/LargePayloadStore', () => ({
  isPayloadRef: vi.fn().mockReturnValue(false),
  retrievePayload: vi.fn(),
}));

vi.mock('../../MessageRouter', () => ({
  MessageType: {
    SUBMISSION: 'SUBMISSION',
    PING: 'PING',
    HEALTH_CHECK: 'HEALTH_CHECK',
    GET_STATE: 'GET_STATE',
    SESSION_RESET: 'SESSION_RESET',
    RESUME_SESSION: 'RESUME_SESSION',
    INTERRUPT: 'INTERRUPT',
    CONFIG_UPDATE: 'CONFIG_UPDATE',
    SKILLS_LIST: 'SKILLS_LIST',
    SKILLS_LOAD: 'SKILLS_LOAD',
    SKILLS_SAVE: 'SKILLS_SAVE',
    SKILLS_DELETE: 'SKILLS_DELETE',
    SKILLS_UPDATE_MODE: 'SKILLS_UPDATE_MODE',
    SKILLS_IMPORT: 'SKILLS_IMPORT',
    SKILLS_EXPORT: 'SKILLS_EXPORT',
    SKILLS_TRUST: 'SKILLS_TRUST',
    EVENT: 'EVENT',
    HEALTH_STATUS: 'HEALTH_STATUS',
    RESPONSE_OUTPUT_TEXT_DELTA: 'RESPONSE_OUTPUT_TEXT_DELTA',
    RESPONSE_REASONING_CONTENT_DELTA: 'RESPONSE_REASONING_CONTENT_DELTA',
    APPROVAL_REQUEST: 'APPROVAL_REQUEST',
  },
}));

// Re-import the mocked MessageType for use in tests
const MessageType = {
  CONFIG_UPDATE: 'CONFIG_UPDATE' as any,
};

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { TauriMessageService } from '../TauriMessageService';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TauriMessageService – CONFIG_UPDATE', () => {
  let service: TauriMessageService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new TauriMessageService();
    await service.initialize();
  });

  it('should route CONFIG_UPDATE to bootstrap.handleConfigUpdate()', async () => {
    await service.send(MessageType.CONFIG_UPDATE);

    expect(mockBootstrap.handleConfigUpdate).toHaveBeenCalledTimes(1);
  });

  it('should return { success: true } on success', async () => {
    const result = await service.send(MessageType.CONFIG_UPDATE);

    expect(result).toEqual({ success: true });
  });

  it('should return { success: false } on error', async () => {
    mockBootstrap.handleConfigUpdate.mockRejectedValue(new Error('reload failed'));

    const result = await service.send(MessageType.CONFIG_UPDATE);

    expect(result).toEqual({ success: false });
  });

  it('should log error on failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBootstrap.handleConfigUpdate.mockRejectedValue(new Error('boom'));

    await service.send(MessageType.CONFIG_UPDATE);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Config update failed'),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});
