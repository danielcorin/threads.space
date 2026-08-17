# Authenticator MFA operations

Threads supports six-digit TOTP authenticator apps for human users. Enrollment
is voluntary by default. An admin may require it instance-wide only after the
admin is enrolled and every human user has a verified recovery email. Bots and
bearer API tokens are not subject to the interactive login policy.

Authenticator entries use the instance hostname as the issuer and the verified
email address as the account label.

## Encryption key

Standalone deployments derive a stable MFA encryption key from
`INSTANCE_SECRET`. You may instead configure a dedicated base64-encoded
`MFA_ENCRYPTION_KEY` containing at least 32 bytes before anyone enrolls.

Never rotate or delete the active key while `mfa_credentials` rows exist. Losing
it makes encrypted TOTP credentials unrecoverable and every affected user must
be reset.

## Recovery

Admins can reset another human user's authenticator in **Admin → Workspace
security**. Resetting removes the credential and revokes all sessions. Admins
cannot reset themselves.

For a sole locked-out admin, use Cloudflare D1 after confirming the exact user:

```sh
npx wrangler d1 execute DB --remote --command \
  "SELECT id, username, is_admin FROM users WHERE is_admin = 1"
npx wrangler d1 execute DB --remote --command \
  "DELETE FROM mfa_login_challenges WHERE user_id = '<user-id>'; DELETE FROM mfa_credentials WHERE user_id = '<user-id>'; DELETE FROM sessions WHERE user_id = '<user-id>';"
```

If instance-wide enforcement remains enabled, the next successful password
login requires immediate re-enrollment.
