import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { api } from '#lib/api.js';
import ApiTokenManager from './ApiTokenManager.svelte';

vi.mock('#lib/api.js', () => ({ api: { users: {
 listApiTokens: vi.fn(), listApiTokensForUser: vi.fn(),
 createApiToken: vi.fn(), createApiTokenForUser: vi.fn(),
 revokeApiToken: vi.fn(), revokeApiTokenForUser: vi.fn(),
} } }));

beforeEach(() => {
 vi.clearAllMocks();
 vi.mocked(api.users.listApiTokens).mockResolvedValue({ tokens: [] });
 vi.mocked(api.users.listApiTokensForUser).mockResolvedValue({ tokens: [] });
 const created = { token: 'test-runtime-secret', id: 'credential-1', name: 'runtime', scopes: ['threads:read', 'threads:write'] as const, expires_at: null };
 vi.mocked(api.users.createApiTokenForUser).mockResolvedValue({ ...created, scopes: [...created.scopes] });
 vi.mocked(api.users.createApiToken).mockResolvedValue({ ...created, scopes: [...created.scopes] });
});

describe('API token ownership', () => {
 it('issues a bot-owned runtime token and clears the one-time display when saved', async () => {
  await render(ApiTokenManager, { userId: 'aster-id', username: 'aster' });
  await expect.element(page.getByText('Tokens for @aster', { exact: true })).toBeVisible();
  await page.getByLabelText('Token name').fill('runtime');
  await page.getByLabelText('Expiry', { exact: true }).selectOptions('never');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect.element(page.getByLabelText('New API token')).toHaveValue('test-runtime-secret');
  expect(api.users.createApiTokenForUser).toHaveBeenCalledWith('aster-id', 'runtime', ['threads:read', 'threads:write'], null);
  expect(api.users.createApiToken).not.toHaveBeenCalled();
  await page.getByRole('button', { name: 'I’ve saved this token' }).click();
  await expect.element(page.getByLabelText('New API token')).not.toBeInTheDocument();
 });

 it('confirms revocation and revokes the selected bot token rather than a personal token', async () => {
  vi.mocked(api.users.listApiTokensForUser).mockResolvedValue({ tokens: [{ id: 'existing-token', name: 'old-runtime', scopes: ['threads:read'], expires_at: null, created_at: 1, last_used_at: null }] });
  vi.mocked(api.users.revokeApiTokenForUser).mockResolvedValue({ ok: true, connections_closed: 1 });
  await render(ApiTokenManager, { userId: 'aster-id', username: 'aster' });
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect.element(page.getByText('Revoke API token', { exact: true })).toBeVisible();
  expect(api.users.revokeApiTokenForUser).not.toHaveBeenCalled();
  await page.getByRole('button', { name: 'Revoke', exact: true }).last().click();
  await expect.poll(() => vi.mocked(api.users.revokeApiTokenForUser).mock.calls.length).toBe(1);
  expect(api.users.revokeApiTokenForUser).toHaveBeenCalledWith('aster-id', 'existing-token');
  expect(api.users.revokeApiToken).not.toHaveBeenCalled();
  await expect.element(page.getByText('old-runtime', { exact: true })).not.toBeInTheDocument();
 });

 it('lets the admin explicitly grant provisioning scopes on a personal token', async () => {
  await render(ApiTokenManager, { allowProvisioning: true });
  await page.getByLabelText('Token name').fill('provisioning');
  await page.getByLabelText('Access', { exact: true }).selectOptions('provisioning');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect.poll(() => vi.mocked(api.users.createApiToken).mock.calls.length).toBe(1);
  expect(api.users.createApiToken).toHaveBeenCalledWith('provisioning', ['threads:read', 'threads:write', 'users:provision', 'tokens:manage'], 90);
  expect(api.users.createApiTokenForUser).not.toHaveBeenCalled();
 });
});
