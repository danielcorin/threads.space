# Application observability events

The Threads Worker emits structured JSON events to Cloudflare Workers Logs with
`console.log(object)`. The root Wrangler config enables Workers Logs and tracing
with a 5% head-sampling rate.

Every application event includes:

| Field | Meaning |
| --- | --- |
| `event` | Stable event name |
| `event_schema` | Schema identifier (`threads.app_event.v1`) |
| `service` | Emitting service (`threads-api`) |
| `environment` | Runtime environment |

## Emitted events

| Event | Outcomes | Useful fields |
| --- | --- | --- |
| `threads.auth.login` | `success`, `failure`, `rejected`, `rate_limited`, `mfa_required` | `reason`, `auth_method`, and actor fields on success |
| `threads.auth.logout` | `success`, `invalid_session`, `no_session` | `auth_method` |
| `threads.message.sent` | `created` | Actor, message and channel IDs; actor/message/channel kinds; placement; content/attachment size buckets |

Message events are emitted only after their transaction commits, so an
idempotent retry does not emit a duplicate. Aggregate message analytics are
written separately to the `threads_message_events` Analytics Engine dataset.
Identifiers in that dataset are HMAC-derived from the instance secret.

Events intentionally omit usernames, IP addresses, passwords, cookies, API and
session tokens, message content, attachment names, and arbitrary metadata.
Login failures use the same `invalid_credentials` reason for unknown users and
wrong passwords.
