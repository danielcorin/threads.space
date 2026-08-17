import { describe, expect, it } from 'vitest';
import { shouldSendPushForMessage } from '../services/messages.js';

describe('shouldSendPushForMessage', () => {
  it('allows human and top-level response messages', () => {
    expect(shouldSendPushForMessage({ messageType: 'human', senderRole: 'user' })).toBe(true);
    expect(shouldSendPushForMessage({ messageType: 'response', senderRole: 'bot' })).toBe(true);
  });

  it('skips progress, thinking, and tool output messages', () => {
    for (const messageType of ['progress', 'thinking', 'tool_output']) {
      expect(shouldSendPushForMessage({ messageType, senderRole: 'bot' })).toBe(false);
    }
  });

  it('skips bot messages mislabeled as human and threaded bot responses', () => {
    expect(shouldSendPushForMessage({ messageType: 'human', senderRole: 'bot' })).toBe(false);
    expect(shouldSendPushForMessage({ messageType: 'response', senderRole: 'bot', threadId: 'root-1' })).toBe(false);
  });
});
