<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api.js';
	import type { WorkspaceSecurityResponse } from '$lib/api.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import Section from '../ui/Section.svelte';
	import Banner from '../ui/Banner.svelte';
	import Field from '../ui/Field.svelte';
	import Select from '../ui/Select.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Button from '../ui/Button.svelte';
	import MfaCodeInput from './MfaCodeInput.svelte';

	// Workspace MFA policy. The confirm box only appears when the toggle differs
	// from the applied policy, so the password prompt is tied to a visible change.
	let workspaceSecurity = $state<WorkspaceSecurityResponse | null>(null);
	let workspaceSecurityLoading = $state(false);
	let policyDesired = $state(false);
	let policyPassword = $state('');
	let policyCode = $state('');
	let policyError = $state('');
	let policySuccess = $state('');
	let policySaving = $state(false);

	const policyDirty = $derived(
		workspaceSecurity != null && policyDesired !== workspaceSecurity.requireMfaForHumans
	);

	async function loadWorkspaceSecurity() {
		workspaceSecurityLoading = true;
		try {
			workspaceSecurity = await api.workspace.security();
			policyDesired = workspaceSecurity.requireMfaForHumans;
		} catch (err: any) {
			policyError = err.message || 'Failed to load workspace security';
		} finally {
			workspaceSecurityLoading = false;
		}
	}

	function cancelPolicyChange() {
		policyDesired = workspaceSecurity?.requireMfaForHumans ?? false;
		policyPassword = '';
		policyCode = '';
		policyError = '';
	}

	async function applyPolicy() {
		policyError = '';
		policySuccess = '';
		if (!policyPassword) {
			policyError = 'Enter your current password to change the workspace policy';
			return;
		}
		policySaving = true;
		try {
			workspaceSecurity = await api.workspace.updateSecurity(
				policyDesired,
				policyPassword,
				policyCode || undefined
			);
			policyPassword = '';
			policyCode = '';
			policySuccess = policyDesired
				? 'Authenticator MFA is now required for human users.'
				: 'Workspace-wide authenticator enforcement is off.';
		} catch (err: any) {
			// Keep the toggle where the admin left it so they can fix the password
			// and retry; Cancel reverts it.
			policyError = err.message || 'Failed to update workspace security';
		} finally {
			policySaving = false;
		}
	}

	// Per-user MFA reset. Each reset confirms with its own credentials inline
	// under the member row it applies to.
	let resetOpenId = $state<string | null>(null);
	let resetPassword = $state('');
	let resetCode = $state('');
	let resetError = $state('');
	let resetSuccess = $state('');
	let resettingId = $state<string | null>(null);

	function openReset(userId: string) {
		resetOpenId = resetOpenId === userId ? null : userId;
		resetPassword = '';
		resetCode = '';
		resetError = '';
		resetSuccess = '';
	}

	async function confirmResetMfa(userId: string, username: string) {
		resetError = '';
		resetSuccess = '';
		if (!resetPassword) {
			resetError = 'Enter your current password to reset an authenticator';
			return;
		}
		resettingId = userId;
		try {
			await api.workspace.resetUserMfa(userId, resetPassword, resetCode || undefined);
			resetPassword = '';
			resetCode = '';
			resetOpenId = null;
			resetSuccess = `Reset authenticator access for ${username} and signed out their sessions.`;
			await loadWorkspaceSecurity();
		} catch (err: any) {
			resetError = err.message || 'Failed to reset authenticator access';
		} finally {
			resettingId = null;
		}
	}

	// Create user.
	let newUsername = $state('');
	let newUserPassword = $state('');
	let newUserEmail = $state('');
	let newUserDisplayName = $state('');
	let newUserRole = $state<'human' | 'bot'>('human');
	let createUserError = $state('');
	let createUserLoading = $state(false);
	let createdUser = $state<{
		username: string;
		needsEmailVerification: boolean;
		emailVerificationSent: boolean;
	} | null>(null);

	async function handleCreateUser() {
		createUserError = '';
		createdUser = null;

		if (!newUsername.trim() || !newUserPassword || (newUserRole === 'human' && !newUserEmail.trim())) {
			createUserError = 'Username, password, and email are required for human users';
			return;
		}
		const email = newUserEmail.trim();
		if (email && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)) {
			createUserError = 'Enter a valid email address';
			return;
		}
		if (newUserPassword.length < 8) {
			createUserError = 'Password must be at least 8 characters';
			return;
		}

		createUserLoading = true;
		try {
			const result = await api.users.create({
				username: newUsername.trim(),
				password: newUserPassword,
				email: email || undefined,
				displayName: newUserDisplayName.trim() || undefined,
				role: newUserRole
			});
			createdUser = {
				username: result.username,
				needsEmailVerification: newUserRole === 'human',
				emailVerificationSent: result.emailVerificationSent
			};
			newUsername = '';
			newUserPassword = '';
			newUserEmail = '';
			newUserDisplayName = '';
			newUserRole = 'human';
		} catch (err: any) {
			createUserError = err.message || 'Failed to create user';
		} finally {
			createUserLoading = false;
		}
	}

	onMount(loadWorkspaceSecurity);
</script>

<Section
	first
	title="MFA policy"
	description="Require every human user to enter an authenticator code when they sign in with a password."
>
	{#if policyError}<Banner variant="error">{policyError}</Banner>{/if}
	{#if policySuccess}<Banner variant="success">{policySuccess}</Banner>{/if}

	{#if workspaceSecurityLoading && !workspaceSecurity}
		<div class="text-sm text-[var(--color-text-muted)]">Loading…</div>
	{:else if workspaceSecurity}
		<div class="flex items-center justify-between gap-3">
			<div>
				<div class="text-sm font-medium">Require authenticator MFA</div>
				<div class="text-xs text-[var(--color-text-muted)]">
					{workspaceSecurity.enrolledHumans} of {workspaceSecurity.totalHumans} human users enrolled
				</div>
			</div>
			<Toggle
				checked={policyDesired}
				onchange={() => (policyDesired = !policyDesired)}
				disabled={policySaving}
				label="Require authenticator MFA for human users"
			/>
		</div>
		<p class="text-xs text-[var(--color-text-muted)] mt-2">
			Applies on the next password sign-in. Bots, API bearer tokens, and sessions that are already active are unaffected.
		</p>

		{#if policyDesired && workspaceSecurity.unverifiedHumans > 0}
			<Banner variant="warning">
				{workspaceSecurity.unverifiedHumans} human {workspaceSecurity.unverifiedHumans === 1 ? 'user does' : 'users do'} not have a verified recovery email. Enforcement cannot be enabled until all are verified.
			</Banner>
		{/if}

		{#if policyDirty}
			<div class="mt-4 border border-[var(--color-border)] rounded px-3 py-3">
				<div class="text-sm font-medium mb-3">
					Confirm: {policyDesired ? 'require' : 'stop requiring'} authenticator MFA for all human users
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<Field
						id="workspace-security-password"
						type="password"
						label="Your current password"
						autocomplete="current-password"
						bind:value={policyPassword}
					/>
					<MfaCodeInput id="workspace-security-code" label="Your authenticator code" hint="(if enabled)" bind:value={policyCode} />
				</div>
				<div class="flex gap-2 mt-3">
					<Button variant="primary" onclick={applyPolicy} disabled={policySaving || !policyPassword}>
						{policySaving ? 'Saving…' : 'Apply policy'}
					</Button>
					<Button variant="secondary" onclick={cancelPolicyChange} disabled={policySaving}>Cancel</Button>
				</div>
			</div>
		{/if}
	{/if}
</Section>

<Section
	title="Members"
	description="Recovery and MFA status for each human user. Resetting an authenticator signs that user out everywhere so they can re-enroll."
>
	{#if resetError}<Banner variant="error">{resetError}</Banner>{/if}
	{#if resetSuccess}<Banner variant="success">{resetSuccess}</Banner>{/if}

	{#if workspaceSecurity}
		<ul class="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded">
			{#each workspaceSecurity.users as securityUser (securityUser.id)}
				<li class="px-3 py-2">
					<div class="flex items-center justify-between gap-3">
						<div class="min-w-0">
							<div class="text-sm font-medium truncate">{securityUser.display_name || securityUser.username}</div>
							<div class="text-xs text-[var(--color-text-muted)] truncate">
								{securityUser.email || 'No recovery email'} · {securityUser.email_verified_at ? 'Email verified' : 'Email unverified'} · {securityUser.mfa_enabled ? 'MFA enabled' : 'MFA not enabled'}
							</div>
						</div>
						{#if securityUser.mfa_enabled && securityUser.id !== auth.user?.id}
							<Button
								variant="danger"
								size="xs"
								class="shrink-0"
								onclick={() => openReset(securityUser.id)}
								disabled={resettingId !== null}
							>
								{resetOpenId === securityUser.id ? 'Cancel' : 'Reset MFA'}
							</Button>
						{/if}
					</div>
					{#if resetOpenId === securityUser.id}
						<div class="mt-3 border-t border-[var(--color-border)] pt-3">
							<div class="text-xs text-[var(--color-text-muted)] mb-2">
								Confirm with your own credentials to reset the authenticator for {securityUser.username}.
							</div>
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
								<Field
									id="reset-mfa-password"
									type="password"
									label="Your current password"
									autocomplete="current-password"
									bind:value={resetPassword}
								/>
								<MfaCodeInput id="reset-mfa-code" label="Your authenticator code" hint="(if enabled)" bind:value={resetCode} />
							</div>
							<Button
								variant="danger"
								size="sm"
								class="mt-3"
								onclick={() => confirmResetMfa(securityUser.id, securityUser.username)}
								disabled={resettingId !== null || !resetPassword}
							>
								{resettingId === securityUser.id ? 'Resetting…' : `Reset MFA for ${securityUser.username}`}
							</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if workspaceSecurityLoading}
		<div class="text-sm text-[var(--color-text-muted)]">Loading…</div>
	{/if}
</Section>

<Section title="Create user" description="Add a human teammate or a bot account to this workspace.">
	{#if createUserError}<Banner variant="error">{createUserError}</Banner>{/if}
	{#if createdUser}
		<Banner variant="success">
			Created user <span class="font-semibold">{createdUser.username}</span>.
			{#if createdUser.emailVerificationSent}
				<span> A confirmation email was sent to them.</span>
			{:else if createdUser.needsEmailVerification}
				<span> The confirmation email could not be sent automatically; they can resend it from Settings after signing in.</span>
			{/if}
		</Banner>
	{/if}

	<div class="space-y-3">
		<Field id="admin-username" label="Username" autocomplete="off" bind:value={newUsername} maxlength={100} placeholder="username" />
		<Field
			id="admin-email"
			type="email"
			label="Email"
			hint={newUserRole === 'bot' ? '(optional for bots)' : undefined}
			autocomplete="email"
			bind:value={newUserEmail}
			maxlength={254}
			required={newUserRole === 'human'}
			placeholder="user@example.com"
		/>
		<Field
			id="admin-password"
			type="password"
			label="Initial password"
			autocomplete="new-password"
			bind:value={newUserPassword}
			placeholder="At least 8 characters"
		/>
		<Field id="admin-display-name" label="Display name" hint="(optional)" bind:value={newUserDisplayName} maxlength={100} placeholder="Display name" />
		<Select id="admin-role" label="Role" bind:value={newUserRole}>
			<option value="human">Human</option>
			<option value="bot">Bot</option>
		</Select>
		<Button
			variant="primary"
			onclick={handleCreateUser}
			disabled={createUserLoading || !newUsername.trim() || !newUserPassword || (newUserRole === 'human' && !newUserEmail.trim())}
		>
			{createUserLoading ? 'Creating…' : 'Create user'}
		</Button>
	</div>
</Section>
