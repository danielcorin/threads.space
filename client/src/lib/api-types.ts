/**
 * OpenAPI-generated wire types, shared from the api workspace.
 *
 * The source of truth is api/openapi/threads.yaml; the .d.ts is emitted by
 * `npm --prefix api run openapi:types` (run automatically by openapi:check,
 * which both the pre-commit gate and CI execute before the client checks).
 */
import type { components } from '../../../api/generated/types/threads.js';

export type Schemas = components['schemas'];

export type ApiMessage = Schemas['Message'];
export type ApiMessagePage = Schemas['MessagePage'];
export type ApiInboxPage = Schemas['InboxPage'];
export type ApiChannel = Schemas['Channel'];
export type ApiChannelListItem = Schemas['ChannelListItem'];
export type ApiChannelBrowseItem = Schemas['ChannelBrowseItem'];
