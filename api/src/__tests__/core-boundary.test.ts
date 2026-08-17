import { describe, expect, it } from 'vitest';
import { BASIC_API_GROUPS, NON_BASIC_API_GROUPS, isBasicApiGroup, isNonBasicApiGroup } from '../core/kernel.js';

describe('basic Cloudflare API boundary', () => {
  it('names the basics-only API groups separately from non-basic current product groups', () => {
    expect(BASIC_API_GROUPS.map((group) => group.name)).toEqual([
      'identity',
      'conversation-spaces',
      'messages',
      'realtime',
    ]);
    expect(NON_BASIC_API_GROUPS.map((group) => group.name)).toEqual([
      'ephemeral-channels',
      'boards-and-widgets',
      'productivity-extras',
      'operations-and-integrations',
      'agent-processes',
    ]);
  });

  it('keeps boards and ephemeral channels outside the first backend baseline', () => {
    const nonBasicRoutes = NON_BASIC_API_GROUPS.flatMap((group) => group.routes);
    expect(nonBasicRoutes).toContain('/channels/:id/board');
    expect(nonBasicRoutes).toContain('/channels/ephemeral');
    expect(nonBasicRoutes).not.toContain('/channels/:id/document');
    expect(nonBasicRoutes).not.toContain('/proof/token');

    const basicRoutes = BASIC_API_GROUPS.flatMap((group) => group.routes);
    expect(basicRoutes).not.toContain('/channels/:id/board');
    expect(basicRoutes).not.toContain('/channels/ephemeral');
    expect(basicRoutes).not.toContain('/channels/:id/document');
    expect(basicRoutes).not.toContain('/proof/token');
  });

  it('uses one identity model with roles/capabilities as attributes', () => {
    const identity = BASIC_API_GROUPS.find((group) => group.name === 'identity');
    expect(identity?.owns).toContain('Single user model');
    expect(identity?.owns).toContain('roles/capabilities as attributes');
  });

  it('exposes type guards for future route/UI registration seams', () => {
    expect(isBasicApiGroup('messages')).toBe(true);
    expect(isBasicApiGroup('boards-and-widgets')).toBe(false);
    expect(isNonBasicApiGroup('boards-and-widgets')).toBe(true);
    expect(isNonBasicApiGroup('conversation-spaces')).toBe(false);
  });
});
