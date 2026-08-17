import type { ChatRoom } from './chat-room.js';
import type { PresenceRoom } from './presence-room.js';
import type { UserEventsRoom } from './user-events-room.js';

/** Minimal lifecycle capability needed by services that schedule background work. */
export interface BackgroundTaskContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  MESSAGE_ANALYTICS?: AnalyticsEngineDataset;
  // Workers AI. Optional: absent in the local test harness (vitest-pool-workers),
  // where /transcribe returns 501 rather than invoking a model.
  AI?: Ai;
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  PRESENCE_ROOM: DurableObjectNamespace<PresenceRoom>;
  USER_EVENTS_ROOM: DurableObjectNamespace<UserEventsRoom>;
  ENVIRONMENT: string;
  // Required in standalone deployments. It protects stored credentials,
  // derives the MFA key, and authorizes first-admin bootstrap.
  INSTANCE_SECRET?: string;
  // Public origin(s) of this instance, comma-separated. Drives CORS and widget
  // iframe embedding. e.g. "https://threads.example.com".
  APP_ORIGIN?: string;
  COOKIE_DOMAIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  // VAPID contact (RFC 8292 `sub`), e.g. "mailto:admin@example.com".
  VAPID_SUBJECT?: string;
  // Local-dev escape hatch: when "true", the webhook SSRF guard permits http and
  // localhost/private targets so a webhook can point at a receiver on the same
  // machine. Set only in .dev.vars — never in production. See lib/webhooks.ts.
  WEBHOOK_ALLOW_INSECURE_URLS?: string;
  // Optional short git SHA of the deployed revision. Surfaced by GET /health.
  GIT_SHA?: string;
  // Optional feedback-channel email egress (see lib/feedback.ts). Feedback
  // email is skipped unless both RESEND_API_KEY and FEEDBACK_EMAIL_TO are set.
  RESEND_API_KEY?: string;
  FEEDBACK_EMAIL_TO?: string;
  FEEDBACK_EMAIL_FROM?: string;
  // Sender address for account verification and recovery messages. Falls back
  // to FEEDBACK_EMAIL_FROM.
  AUTH_EMAIL_FROM?: string;
  // Optional dedicated secret used only to derive irreversible analytics identifiers.
  // Analytics emission is skipped when this or MESSAGE_ANALYTICS is absent.
  ANALYTICS_HASH_SECRET?: string;
  // Versioned HMAC root for credential verifiers and derived webhook signing
  // secrets. Managed as a Worker secret, never stored in D1.
  CREDENTIAL_MASTER_KEY?: string;
  // Optional dedicated AES-256-GCM key for authenticator-app secrets. When
  // absent, Threads derives one from INSTANCE_SECRET.
  MFA_ENCRYPTION_KEY?: string;
}

export interface User {
  id: string;
  username: string;
  email: string | null;
  email_normalized: string | null;
  email_verified_at: number | null;
  display_name: string | null;
  name_color: string | null;
  code_theme: string | null;
  is_admin: number;
  avatar_url: string | null;
  role: string;
  bot_capabilities_json: string | null;
  ephemeral_bot_id: string | null;
  created_at: number;
}

export interface Session {
  token: string;
  user_id: string;
  expires_at: number;
}

export interface Channel {
  id: string;
  name: string;
  description: string | null;
  is_private: number;
  processing_mode: string;
  auto_respond_bot_id: string | null;
  created_by: string;
  created_at: number;
  is_ephemeral?: number;
  auto_named_at?: number | null;
  archived_at?: number | null;
}

export interface Message {
  id: string;
  channel_id: string;
  user_id: string | null;
  content: string | null;
  thread_id: string | null;
  thread_title: string | null;
  thread_title_updated_at: number | null;
  type: 'message' | 'system';
  message_type: 'human' | 'response' | 'progress' | 'tool_output' | 'thinking';
  edited_at: number | null;
  deleted_at: number | null;
  created_at: number;
}

export interface Reaction {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: number;
}

export interface Widget {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  code: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelWidget {
  channel_id: string;
  widget_id: string;
  added_by: string;
  added_at: string;
}

export interface ChannelFolder {
  id: string;
  user_id: string;
  name: string;
  position: number;
  collapsed: number;
  created_at: number;
  channels: string[];
}

export interface AuthenticatedRequest {
  user: User;
}
