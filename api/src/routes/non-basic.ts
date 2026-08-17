import { errorResponse } from '../utils.js';
import { handleGetErrors } from './users.js';
import { handleCreateEphemeralChannel, handleArchiveEphemeralChannel, handleUnarchiveEphemeralChannel, handleRenameEphemeralChannel, handlePromoteEphemeralChannel, handleRegenerateEphemeralName } from './channels.js';
import { handleListDrafts, handleGetDraft, handlePutDraft } from './drafts.js';
import { handleGetBoard, handleCreateBoard, handleUpdateBoard, handleCreateCard, handleUpdateCard, handleDeleteCard, handleGetCardActivity } from './kanban.js';
import { handleUpdateProcessStatus, handleRetryMessage } from './messages.js';
import { handlePinMessage, handleUnpinMessage, handleListPins } from './pins.js';
import { handleListProcesses, handleGetProcess, handleCreateProcess, handleCleanupProcessesByBot, handleUpdateProcess, handleProcessActivity, handleKillProcess, handleKillAllProcesses } from './processes.js';
import { handleGetVapidKey, handleSubscribe, handleUnsubscribe, handleGetPreferences, handleUpdatePreferences } from './push.js';
import { handleCreateSavedDraft, handleListSavedDrafts, handleDeleteSavedDraft, handleScheduleSavedDraft } from './saved-drafts.js';
import { handleGetSyncState, handleGetSyncStateByPrefix, handlePutSyncState } from './sync-state.js';
import { handleTranscribe } from './transcribe.js';
import { handleWidgetKvGet, handleWidgetKvGetGlobal, handleWidgetKvPut, handleWidgetKvDelete } from './widget-data.js';
import { handleListWidgets, handleGetWidget, handleCreateWidget, handleUpdateWidget, handleDeleteWidget, handleListChannelWidgets, handleAddWidgetToChannel, handleRemoveWidgetFromChannel, handleWidgetRuntime } from './widgets.js';
import type { ThreadsApp } from './types.js';

export const EXTENSION_ROUTE_INVENTORY = [
  { method: 'GET', path: '/w/:id' },
  { method: 'POST', path: '/channels/ephemeral' },
  { method: 'POST', path: '/channels/:id/archive' },
  { method: 'DELETE', path: '/channels/:id/archive' },
  { method: 'POST', path: '/channels/:id/rename' },
  { method: 'POST', path: '/channels/:id/promote' },
  { method: 'POST', path: '/channels/:id/regenerate-name' },
  { method: 'GET', path: '/channels/:id/pins' },
  { method: 'POST', path: '/channels/:id/pins' },
  { method: 'DELETE', path: '/channels/:id/pins/:messageId' },
  { method: 'GET', path: '/channels/:id/board' },
  { method: 'POST', path: '/channels/:id/board' },
  { method: 'PUT', path: '/channels/:id/board' },
  { method: 'POST', path: '/channels/:id/board/cards' },
  { method: 'PUT', path: '/boards/cards/:cardId' },
  { method: 'DELETE', path: '/boards/cards/:cardId' },
  { method: 'GET', path: '/boards/cards/:cardId/activity' },
  { method: 'GET', path: '/widgets' },
  { method: 'POST', path: '/widgets' },
  { method: 'GET', path: '/widgets/:id' },
  { method: 'PUT', path: '/widgets/:id' },
  { method: 'DELETE', path: '/widgets/:id' },
  { method: 'GET', path: '/channels/:id/widgets' },
  { method: 'POST', path: '/channels/:id/widgets' },
  { method: 'DELETE', path: '/channels/:id/widgets/:widgetId' },
  { method: 'GET', path: '/widgets/:id/data/kv/:key/all' },
  { method: 'GET', path: '/widgets/:id/data/kv/:key' },
  { method: 'PUT', path: '/widgets/:id/data/kv/:key' },
  { method: 'DELETE', path: '/widgets/:id/data/kv/:key' },
  { method: 'GET', path: '/push/vapid-key' },
  { method: 'POST', path: '/push/subscribe' },
  { method: 'DELETE', path: '/push/subscribe' },
  { method: 'GET', path: '/push/preferences' },
  { method: 'PUT', path: '/push/preferences' },
  { method: 'GET', path: '/sync-state' },
  { method: 'GET', path: '/sync-state/:key{.+}' },
  { method: 'PUT', path: '/sync-state/:key{.+}' },
  { method: 'GET', path: '/drafts' },
  { method: 'GET', path: '/channels/:id/draft' },
  { method: 'PUT', path: '/channels/:id/draft' },
  { method: 'GET', path: '/channels/:id/saved-drafts' },
  { method: 'POST', path: '/channels/:id/saved-drafts' },
  { method: 'DELETE', path: '/saved-drafts/:id' },
  { method: 'PATCH', path: '/saved-drafts/:id/schedule' },
  { method: 'POST', path: '/messages/:id/process' },
  { method: 'POST', path: '/messages/:id/retry' },
  { method: 'GET', path: '/processes' },
  { method: 'POST', path: '/processes' },
  { method: 'POST', path: '/processes/cleanup-by-bot' },
  { method: 'POST', path: '/processes/kill-all' },
  { method: 'GET', path: '/processes/:id' },
  { method: 'PATCH', path: '/processes/:id' },
  { method: 'POST', path: '/processes/:id/activity' },
  { method: 'DELETE', path: '/processes/:id' },
  { method: 'POST', path: '/transcribe' },
  { method: 'GET', path: '/errors' },
] as const;

export const NON_BASIC_ROUTE_INVENTORY = EXTENSION_ROUTE_INVENTORY;

export function registerNonBasicPublicRoutes(app: ThreadsApp): void {
  // Scheduled draft delivery runs via the native scheduled() cron handler in
  // index.ts — there is no HTTP trigger. Operator user-management actions moved
  // to the admin-user endpoints in basic.ts (POST /users/:id/reset-password,
  // DELETE /users/:id, DELETE /users/:id/api-tokens/:tokenId, GET /errors).

  // --- Widget runtime (auth checked inline) ---
  app.get('/w/:id', (c) => handleWidgetRuntime(c.req.raw, c.env, c.req.param('id')));
}

export function registerNonBasicAuthenticatedRoutes(authed: ThreadsApp): void {
  // Ephemeral channels
  authed.post('/channels/ephemeral', (c) => handleCreateEphemeralChannel(c.req.raw, c.env, c.get('user'), c.executionCtx));
  authed.post('/channels/:id/archive', (c) => handleArchiveEphemeralChannel(c.env, c.get('user'), c.req.param('id')));
  authed.delete('/channels/:id/archive', (c) => handleUnarchiveEphemeralChannel(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/rename', (c) => handleRenameEphemeralChannel(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/promote', (c) => handlePromoteEphemeralChannel(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/regenerate-name', (c) => handleRegenerateEphemeralName(c.env, c.get('user'), c.req.param('id')));

  // Pins
  authed.get('/channels/:id/pins', (c) => handleListPins(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/pins', (c) => handlePinMessage(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/channels/:id/pins/:messageId', (c) => handleUnpinMessage(c.env, c.get('user'), c.req.param('id'), c.req.param('messageId')));

  // Kanban
  authed.get('/channels/:id/board', (c) => handleGetBoard(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/board', (c) => handleCreateBoard(c.env, c.get('user'), c.req.param('id')));
  authed.put('/channels/:id/board', (c) => handleUpdateBoard(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/board/cards', (c) => handleCreateCard(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.put('/boards/cards/:cardId', (c) => handleUpdateCard(c.req.raw, c.env, c.get('user'), c.req.param('cardId')));
  authed.delete('/boards/cards/:cardId', (c) => handleDeleteCard(c.env, c.get('user'), c.req.param('cardId')));
  authed.get('/boards/cards/:cardId/activity', (c) => handleGetCardActivity(c.env, c.get('user'), c.req.param('cardId')));

  // Widgets
  authed.get('/widgets', (c) => handleListWidgets(c.env, c.get('user')));
  authed.post('/widgets', (c) => handleCreateWidget(c.req.raw, c.env, c.get('user')));
  authed.get('/widgets/:id', (c) => handleGetWidget(c.env, c.get('user'), c.req.param('id')));
  authed.put('/widgets/:id', (c) => handleUpdateWidget(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/widgets/:id', (c) => handleDeleteWidget(c.env, c.get('user'), c.req.param('id')));
  authed.get('/channels/:id/widgets', (c) => handleListChannelWidgets(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/widgets', (c) => handleAddWidgetToChannel(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/channels/:id/widgets/:widgetId', (c) => handleRemoveWidgetFromChannel(c.env, c.get('user'), c.req.param('id'), c.req.param('widgetId')));

  // Widget KV (durable per-widget key/value store)
  authed.get('/widgets/:id/data/kv/:key/all', (c) => handleWidgetKvGetGlobal(c.env, c.get('user'), c.req.param('id'), c.req.param('key')));
  authed.get('/widgets/:id/data/kv/:key', (c) => handleWidgetKvGet(c.env, c.get('user'), c.req.param('id'), c.req.param('key')));
  authed.put('/widgets/:id/data/kv/:key', (c) => handleWidgetKvPut(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.req.param('key')));
  authed.delete('/widgets/:id/data/kv/:key', (c) => handleWidgetKvDelete(c.env, c.get('user'), c.req.param('id'), c.req.param('key')));

  // Push notifications
  authed.get('/push/vapid-key', (c) => handleGetVapidKey(c.env));
  authed.post('/push/subscribe', (c) => handleSubscribe(c.req.raw, c.env, c.get('user')));
  authed.delete('/push/subscribe', (c) => handleUnsubscribe(c.req.raw, c.env, c.get('user')));
  authed.get('/push/preferences', (c) => handleGetPreferences(c.env, c.get('user')));
  authed.put('/push/preferences', (c) => handleUpdatePreferences(c.req.raw, c.env, c.get('user')));

  // Sync state
  authed.get('/sync-state', (c) => {
    const prefix = new URL(c.req.url).searchParams.get('prefix');
    if (!prefix) return errorResponse('prefix query parameter is required');
    return handleGetSyncStateByPrefix(c.env, c.get('user'), prefix);
  });
  authed.get('/sync-state/:key{.+}', (c) => handleGetSyncState(c.env, c.get('user'), decodeURIComponent(c.req.param('key'))));
  authed.put('/sync-state/:key{.+}', (c) => handlePutSyncState(c.req.raw, c.env, c.get('user'), decodeURIComponent(c.req.param('key'))));

  // Drafts
  authed.get('/drafts', (c) => handleListDrafts(c.env, c.get('user')));
  authed.get('/channels/:id/draft', (c) => handleGetDraft(c.env, c.get('user'), c.req.param('id')));
  authed.put('/channels/:id/draft', (c) => handlePutDraft(c.req.raw, c.env, c.get('user'), c.req.param('id')));

  // Saved Drafts
  authed.get('/channels/:id/saved-drafts', (c) => handleListSavedDrafts(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/saved-drafts', (c) => handleCreateSavedDraft(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/saved-drafts/:id', (c) => handleDeleteSavedDraft(c.env, c.get('user'), c.req.param('id')));
  authed.patch('/saved-drafts/:id/schedule', (c) => handleScheduleSavedDraft(c.req.raw, c.env, c.get('user'), c.req.param('id')));

  // Agent/process message operations. Agents mark a message processing/done (and
  // attach token usage) via /process; channel members re-run a failed message via
  // /retry. The threads-agent-bridge calls /process around each Claude run.
  authed.post('/messages/:id/process', (c) => handleUpdateProcessStatus(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.post('/messages/:id/retry', (c) => handleRetryMessage(c.env, c.get('user'), c.req.param('id')));

  // Agent processes. Bots report their own run lifecycle (create/update/activity);
  // any channel member (or admin) can cancel a run, which signals the agent over WS +
  // webhook (see ProcessService.killProcess). There is no pid — runs are identified by
  // their own id and cancellation is cooperative.
  authed.get('/processes', (c) => handleListProcesses(c.env, c.get('user'), new URL(c.req.url)));
  authed.post('/processes', (c) => handleCreateProcess(c.req.raw, c.env, c.get('user'), c.executionCtx));
  authed.post('/processes/cleanup-by-bot', (c) => handleCleanupProcessesByBot(c.env, c.get('user'), c.executionCtx));
  authed.post('/processes/kill-all', (c) => handleKillAllProcesses(c.env, c.get('user'), c.executionCtx));
  authed.get('/processes/:id', (c) => handleGetProcess(c.env, c.get('user'), c.req.param('id')));
  authed.patch('/processes/:id', (c) => handleUpdateProcess(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.executionCtx));
  authed.post('/processes/:id/activity', (c) => handleProcessActivity(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.executionCtx));
  authed.delete('/processes/:id', (c) => handleKillProcess(c.env, c.get('user'), c.req.param('id'), c.executionCtx));

  // Voice-to-text: transcribe a composer voice memo via Workers AI (Whisper).
  authed.post('/transcribe', (c) => handleTranscribe(c.req.raw, c.env, c.get('user')));

  // Admin-only diagnostics: recent server error-log rows (is_admin gated).
  authed.get('/errors', (c) => handleGetErrors(c.env, c.get('principal')));

}
