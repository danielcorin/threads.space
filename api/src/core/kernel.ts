export const CORE_API_GROUPS = [
  {
    name: 'identity',
    owns: 'Single user model for humans and agents, with roles/capabilities as attributes rather than separate principal types.',
    routes: ['/auth/*', '/users', '/users/me', '/users/me/email/change', '/users/me/email/verification/resend', '/users/me/security', '/users/me/mfa/enrollment', '/users/me/mfa/enrollment/confirm', '/users/me/mfa', '/users/me/frequent-emojis', '/users/me/api-tokens', '/users/me/api-tokens/:id', '/users/me/webhooks', '/users/me/webhooks/:id', '/users/:id/api-tokens', '/users/:id/api-tokens/:tokenId', '/users/:id/reset-password', '/users/:id/mfa', '/users/:id', '/users/search', '/users/bots', '/workspace/security', '/bots/self/capabilities'],
  },
  {
    name: 'conversation-spaces',
    owns: 'Durable, non-ephemeral channels and DMs, including membership, folders, read state, and notification preferences.',
    routes: [
      '/channels',
      '/channels/browse',
      '/channels/:id',
      '/channels/:id/join',
      '/channels/:id/leave',
      '/channels/:id/members',
      '/channels/:id/members/:targetUserId',
      '/channels/:id/membership',
      '/channels/:id/notifications',
      '/channels/:id/read',
      '/inbox',
      '/dms',
      '/dms/reorder',
      '/dms/:id/hide',
      '/folders',
      '/folders/reorder',
      '/folders/:id',
      '/folders/:id/channels',
      '/folders/:id/channels/:channelId',
    ],
  },
  {
    name: 'messages',
    owns: 'Channel messages, thread replies, edits/deletes, attachments, reactions, mentions, search, and link previews.',
    routes: [
      '/channels/:id/messages',
      '/messages/:id',
      '/messages/:id/read',
      '/messages/:id/resolve',
      '/messages/:id/thread-title',
      '/messages/:id/replies',
      '/messages/:id/reactions',
      '/messages/:id/reactions/:emoji',
      '/uploads',
      '/uploads/:key{.+}',
      '/mentions',
      '/search',
      '/link-previews',
    ],
  },
  {
    name: 'realtime',
    owns: 'Channel and presence WebSockets, the owner-scoped /events stream, plus the events needed to keep the current Cloudflare client live.',
    routes: ['/events', '/ws/:channelId', '/ws/presence', '/presence'],
  },
] as const;

export const EXTENSION_API_GROUPS = [
  {
    name: 'ephemeral-channels',
    why: 'Transient-room workflow for this deployment; explicitly outside the reusable backend baseline.',
    routes: ['/channels/ephemeral', '/channels/:id/archive', '/channels/:id/rename', '/channels/:id/promote', '/channels/:id/regenerate-name'],
  },
  {
    name: 'boards-and-widgets',
    why: 'Adjacent collaboration surfaces, not part of the basics-only chat backend API.',
    routes: [
      '/channels/:id/board',
      '/channels/:id/board/cards',
      '/boards/cards/:cardId',
      '/boards/cards/:cardId/activity',
      '/widgets',
      '/widgets/:id',
      '/channels/:id/widgets',
      '/channels/:id/widgets/:widgetId',
      '/widgets/:id/data/*',
      '/w/:id',
    ],
  },
  {
    name: 'productivity-extras',
    why: 'Convenience features that should not define the first reusable backend boundary.',
    routes: [
      '/drafts',
      '/channels/:id/draft',
      '/channels/:id/pins',
      '/channels/:id/pins/:messageId',
      '/channels/:id/saved-drafts',
      '/saved-drafts/*',
      '/push/*',
      '/transcribe',
    ],
  },
  {
    name: 'operations-and-integrations',
    why: 'Deployment, error-log diagnostics, notification delivery, sync, and workspace lifecycle for this instance.',
    routes: ['/errors', '/sync-state/*'],
  },
  {
    name: 'agent-processes',
    why: 'Tracks and cancels agent turns for this instance; cancellation is cooperative (WS + webhook signal), not part of the reusable chat baseline.',
    routes: ['/processes', '/processes/kill-all', '/processes/:id', '/processes/:id/activity', '/messages/:id/process', '/messages/:id/retry'],
  },
] as const;

export const BASIC_API_GROUPS = CORE_API_GROUPS;
export const NON_BASIC_API_GROUPS = EXTENSION_API_GROUPS;
export const INSTANCE_API_GROUPS = EXTENSION_API_GROUPS;

export type CoreApiGroupName = typeof CORE_API_GROUPS[number]['name'];
export type ExtensionApiGroupName = typeof EXTENSION_API_GROUPS[number]['name'];
export type BasicApiGroupName = CoreApiGroupName;
export type NonBasicApiGroupName = ExtensionApiGroupName;
export type InstanceApiGroupName = ExtensionApiGroupName;

export function isCoreApiGroup(name: string): name is CoreApiGroupName {
  return CORE_API_GROUPS.some((group) => group.name === name);
}

export function isExtensionApiGroup(name: string): name is ExtensionApiGroupName {
  return EXTENSION_API_GROUPS.some((group) => group.name === name);
}

export const isBasicApiGroup = isCoreApiGroup;
export const isNonBasicApiGroup = isExtensionApiGroup;
export const isInstanceApiGroup = isExtensionApiGroup;
