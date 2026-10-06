<script lang="ts">
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';
	import Check from 'phosphor-svelte/lib/Check';
	import { api } from '$lib/api.js';
	import type { MfaSetup, MySecurityResponse } from '$lib/api.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import Section from '../ui/Section.svelte';
	import Banner from '../ui/Banner.svelte';
	import Field from '../ui/Field.svelte';
	import Button from '../ui/Button.svelte';
	import MfaCodeInput from './MfaCodeInput.svelte';
	import MfaSetupKey from '../MfaSetupKey.svelte';

	const isBot = $derived(auth.user?.role === 'bot');

	// Recovery email. A replacement stays pending until the recipient follows
	// the emailed link, so a verified address is never displaced prematurely.
	// The form stays collapsed behind "Change email" while the address is
	// verified or a confirmation is already in flight.
	let recoveryEmail = $state(auth.user?.email ?? '');
	let currentRecoveryEmail = $state(auth.user?.email ?? null);
	let recoveryEmailVerifiedAt = $state(auth.user?.email_verified_at ?? null);
	let pendingRecoveryEmail = $state<string | null>(null);
	let recoveryEmailExpiresAt = $state<number | null>(null);
	let recoveryEmailPassword = $state('');
	let recoveryEmailError = $state('');
	let recoveryEmailSuccess = $state('');
	let recoveryEmailLoading = $state(false);
	let recoveryEmailResending = $state(false);
	let emailFormOpen = $state(false);

	const emailNeedsSetup = $derived(!recoveryEmailVerifiedAt && !pendingRecoveryEmail);
	const showEmailForm = $derived(emailFormOpen || emailNeedsSetup);

	function applyRecoveryEmailState(me: Awaited<ReturnType<typeof api.users.me>>) {
		currentRecoveryEmail = me.email;
		recoveryEmailVerifiedAt = me.email_verified_at;
		pendingRecoveryEmail = me.pending_email;
		recoveryEmailExpiresAt = me.email_verification_expires_at;
		recoveryEmail = me.pending_email ?? me.email ?? '';
		auth.updateEmail(me.email, me.email_verified_at);
	}

	function closeEmailForm() {
		emailFormOpen = false;
		recoveryEmail = pendingRecoveryEmail ?? currentRecoveryEmail ?? '';
		recoveryEmailPassword = '';
		recoveryEmailError = '';
	}

	async function handleRecoveryEmailSubmit() {
		recoveryEmailError = '';
		recoveryEmailSuccess = '';
		const email = recoveryEmail.trim();
		if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
			recoveryEmailError = 'Enter a valid email address';
			return;
		}
		if (!recoveryEmailPassword) {
			recoveryEmailError = 'Enter your current password';
			return;
		}

		recoveryEmailLoading = true;
		try {
			const result = await api.users.requestEmailChange(email, recoveryEmailPassword);
			recoveryEmailPassword = '';
			emailFormOpen = false;
			if (result.verified) {
				pendingRecoveryEmail = null;
				recoveryEmailExpiresAt = null;
				recoveryEmailSuccess = 'That email address is already verified.';
			} else {
				pendingRecoveryEmail = result.pendingEmail;
				recoveryEmailExpiresAt = result.expiresAt;
				recoveryEmailSuccess = `We sent a confirmation link to ${result.pendingEmail}.`;
			}
		} catch (err: any) {
			recoveryEmailError = err.message || 'Failed to send verification email';
		} finally {
			recoveryEmailLoading = false;
		}
	}

	async function handleRecoveryEmailResend() {
		recoveryEmailError = '';
		recoveryEmailSuccess = '';
		recoveryEmailResending = true;
		try {
			const result = await api.users.resendEmailVerification();
			pendingRecoveryEmail = result.pendingEmail;
			recoveryEmailExpiresAt = result.expiresAt;
			recoveryEmailSuccess = `We sent a new confirmation link to ${result.pendingEmail}.`;
		} catch (err: any) {
			recoveryEmailError = err.message || 'Failed to resend verification email';
		} finally {
			recoveryEmailResending = false;
		}
	}

	// Authenticator-app MFA. Enrollment secrets remain local to this tab and
	// are discarded as soon as setup completes or the modal closes.
	let mySecurity = $state<MySecurityResponse | null>(null);
	let mySecurityLoading = $state(true);
	let mfaSetup = $state<MfaSetup | null>(null);
	let mfaQrCodeUrl = $state('');
	let mfaPassword = $state('');
	let mfaCode = $state('');
	let mfaError = $state('');
	let mfaSuccess = $state('');
	let mfaLoading = $state(false);
	let showMfaDisable = $state(false);
	let showMfaEnroll = $state(false);

	async function loadMySecurity() {
		if (isBot) {
			mySecurityLoading = false;
			return;
		}
		try {
			mySecurity = await api.users.security();
		} catch (err: any) {
			mfaError = err.message || 'Failed to load authenticator settings';
		} finally {
			mySecurityLoading = false;
		}
	}

	async function beginMfaEnrollment() {
		mfaError = '';
		mfaSuccess = '';
		if (!mfaPassword) {
			mfaError = 'Enter your current password';
			return;
		}
		mfaLoading = true;
		try {
			mfaSetup = await api.users.startMfaEnrollment(mfaPassword);
			mfaQrCodeUrl = await QRCode.toDataURL(mfaSetup.otpauthUri, {
				width: 220,
				margin: 1,
				color: { dark: '#111111', light: '#ffffff' }
			});
			mfaPassword = '';
		} catch (err: any) {
			mfaError = err.message || 'Failed to start authenticator setup';
		} finally {
			mfaLoading = false;
		}
	}

	async function confirmMfaEnrollment() {
		mfaError = '';
		if (!/^\d{6}$/.test(mfaCode)) {
			mfaError = 'Enter the 6-digit code from your authenticator app';
			return;
		}
		mfaLoading = true;
		try {
			await api.users.confirmMfaEnrollment(mfaCode);
			mfaSetup = null;
			mfaQrCodeUrl = '';
			mfaCode = '';
			showMfaEnroll = false;
			mfaSuccess = 'Authenticator app enabled. You will use it the next time you sign in.';
			await loadMySecurity();
		} catch (err: any) {
			mfaError = err.message || 'Could not verify that code';
		} finally {
			mfaLoading = false;
		}
	}

	async function disableMfa() {
		mfaError = '';
		mfaSuccess = '';
		if (!mfaPassword || !/^\d{6}$/.test(mfaCode)) {
			mfaError = 'Enter your current password and 6-digit authenticator code';
			return;
		}
		mfaLoading = true;
		try {
			await api.users.disableMfa(mfaPassword, mfaCode);
			mfaPassword = '';
			mfaCode = '';
			showMfaDisable = false;
			mfaSuccess = 'Authenticator app disabled.';
			await loadMySecurity();
		} catch (err: any) {
			mfaError = err.message || 'Failed to disable authenticator app';
		} finally {
			mfaLoading = false;
		}
	}

	// Change password — stays explicit (needs the current password + confirmation),
	// collapsed behind a button until the user wants it.
	let passwordFormOpen = $state(false);
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let passwordError = $state('');
	let passwordSuccess = $state(false);
	let passwordLoading = $state(false);

	function closePasswordForm() {
		passwordFormOpen = false;
		currentPassword = '';
		newPassword = '';
		confirmPassword = '';
		passwordError = '';
	}

	async function handleChangePassword() {
		passwordError = '';
		passwordSuccess = false;

		if (!currentPassword || !newPassword || !confirmPassword) {
			passwordError = 'All password fields are required';
			return;
		}
		if (newPassword.length < 8) {
			passwordError = 'New password must be at least 8 characters';
			return;
		}
		if (newPassword !== confirmPassword) {
			passwordError = 'New passwords do not match';
			return;
		}
		if (newPassword === currentPassword) {
			passwordError = 'New password must be different from current password';
			return;
		}

		passwordLoading = true;
		try {
			await api.users.changePassword(currentPassword, newPassword);
			passwordSuccess = true;
			closePasswordForm();
		} catch (err: any) {
			passwordError = err.message || 'Failed to change password';
		} finally {
			passwordLoading = false;
		}
	}

	onMount(async () => {
		// Returning from the emailed confirmation link (?email_verified=1).
		if (typeof location !== 'undefined' && new URL(location.href).searchParams.get('email_verified') === '1') {
			recoveryEmailSuccess = 'Email address confirmed successfully.';
			const url = new URL(location.href);
			url.searchParams.delete('email_verified');
			history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
		}
		loadMySecurity();
		if (!isBot) {
			// Fetch fresh /users/me: the cached auth user (from localStorage / login)
			// may predate a pending email change.
			try {
				applyRecoveryEmailState(await api.users.me());
			} catch {
				// Non-fatal: leave email fields on their cached values.
			}
		}
	});
</script>

{#if !isBot}
	<Section
		first
		title="Recovery email"
		description="Used to verify account ownership and recover access if you forget your password."
	>
		{#if recoveryEmailError}<Banner variant="error">{recoveryEmailError}</Banner>{/if}
		{#if recoveryEmailSuccess}<Banner variant="success">{recoveryEmailSuccess}</Banner>{/if}

		{#if currentRecoveryEmail && recoveryEmailVerifiedAt}
			<div class="flex items-center justify-between gap-3 mb-3">
				<div class="flex items-center gap-2 text-sm min-w-0">
					<span class="inline-flex text-[var(--color-success)]"><Check size={16} /></span>
					<span class="truncate"><span class="font-medium">{currentRecoveryEmail}</span> is verified.</span>
				</div>
				{#if !showEmailForm}
					<Button variant="secondary" size="sm" class="shrink-0" onclick={() => (emailFormOpen = true)}>
						Change email
					</Button>
				{/if}
			</div>
		{:else if currentRecoveryEmail && !pendingRecoveryEmail}
			<Banner variant="warning">
				{currentRecoveryEmail} is on your account but has not been verified yet. Re-submit it below to get a new confirmation link.
			</Banner>
		{:else if !currentRecoveryEmail && !pendingRecoveryEmail}
			<Banner variant="warning">Add and verify an email address so your account can be recovered.</Banner>
		{/if}

		{#if pendingRecoveryEmail}
			<div class="bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 mb-3">
				<div class="text-sm font-medium">Waiting for {pendingRecoveryEmail}</div>
				<div class="text-xs text-[var(--color-text-muted)] mt-1">
					Follow the link in that message to confirm the address{recoveryEmailExpiresAt ? ` before ${new Date(recoveryEmailExpiresAt * 1000).toLocaleString()}` : ''}.
					{#if recoveryEmailVerifiedAt} Your current verified address remains active until then.{/if}
				</div>
				<div class="flex flex-wrap gap-2 mt-2">
					<Button
						variant="secondary"
						size="sm"
						onclick={handleRecoveryEmailResend}
						disabled={recoveryEmailResending || recoveryEmailLoading}
					>
						{recoveryEmailResending ? 'Sending…' : 'Resend confirmation'}
					</Button>
					{#if !showEmailForm}
						<Button variant="secondary" size="sm" onclick={() => (emailFormOpen = true)}>
							Use a different email
						</Button>
					{/if}
				</div>
			</div>
		{/if}

		{#if showEmailForm}
			<div class="space-y-3">
				<Field
					id="settings-recovery-email"
					type="email"
					label={recoveryEmailVerifiedAt ? 'New email address' : 'Email address'}
					autocomplete="email"
					bind:value={recoveryEmail}
					maxlength={254}
					required
					placeholder="you@example.com"
				/>
				<Field
					id="settings-email-password"
					type="password"
					label="Current password"
					autocomplete="current-password"
					bind:value={recoveryEmailPassword}
					placeholder="Confirm this change"
				/>
				<div class="flex gap-2">
					<Button
						variant="primary"
						onclick={handleRecoveryEmailSubmit}
						disabled={recoveryEmailLoading || !recoveryEmail.trim() || !recoveryEmailPassword}
					>
						{recoveryEmailLoading ? 'Sending…' : recoveryEmailVerifiedAt ? 'Verify new email' : 'Send verification email'}
					</Button>
					{#if emailFormOpen && !emailNeedsSetup}
						<Button variant="secondary" onclick={closeEmailForm}>Cancel</Button>
					{/if}
				</div>
			</div>
		{/if}
	</Section>

	<Section
		title="Authenticator app"
		description="Use a rotating code from an authenticator app as a second step when signing in."
	>
		{#if mfaError}<Banner variant="error">{mfaError}</Banner>{/if}
		{#if mfaSuccess}<Banner variant="success">{mfaSuccess}</Banner>{/if}

		{#if mySecurityLoading}
			<div class="text-sm text-[var(--color-text-muted)]">Loading…</div>
		{:else if mySecurity?.mfaEnabled}
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="flex items-center gap-2 text-sm font-medium">
						<span class="inline-flex text-[var(--color-success)]"><Check size={16} /></span>
						Authenticator app enabled
					</div>
					<div class="text-xs text-[var(--color-text-muted)] mt-1">
						Your password and a current code are required when you sign in.
					</div>
				</div>
				{#if !mySecurity.mfaRequired}
					<Button variant="danger" size="sm" onclick={() => (showMfaDisable = !showMfaDisable)}>
						Disable
					</Button>
				{/if}
			</div>

			{#if mySecurity.mfaRequired}
				<Banner variant="warning">Your workspace requires authenticator MFA, so it cannot be disabled.</Banner>
			{:else if showMfaDisable}
				<div class="space-y-3 mt-4 border-t border-[var(--color-border)] pt-4">
					<Field id="mfa-disable-password" type="password" label="Current password" autocomplete="current-password" bind:value={mfaPassword} />
					<MfaCodeInput id="mfa-disable-code" bind:value={mfaCode} />
					<Button variant="danger" onclick={disableMfa} disabled={mfaLoading || !mfaPassword || !/^\d{6}$/.test(mfaCode)}>
						{mfaLoading ? 'Disabling…' : 'Disable authenticator app'}
					</Button>
				</div>
			{/if}
		{:else if mfaSetup}
			<div class="space-y-3">
				<p class="text-sm text-[var(--color-text-muted)]">Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
				{#if mfaQrCodeUrl}
					<div class="flex justify-center"><div class="rounded bg-white p-3"><img src={mfaQrCodeUrl} alt="Authenticator setup QR code" width="220" height="220" /></div></div>
				{/if}
				<MfaSetupKey secret={mfaSetup.secret} />
				<MfaCodeInput id="mfa-confirm-code" label="6-digit code" bind:value={mfaCode} />
				<div class="flex gap-2">
					<Button variant="primary" onclick={confirmMfaEnrollment} disabled={mfaLoading || !/^\d{6}$/.test(mfaCode)}>
						{mfaLoading ? 'Verifying…' : 'Verify and enable'}
					</Button>
					<Button variant="secondary" onclick={() => { mfaSetup = null; mfaQrCodeUrl = ''; mfaCode = ''; }}>Cancel</Button>
				</div>
			</div>
		{:else if mySecurity && !mySecurity.emailVerified}
			<Banner variant="warning">Verify your recovery email above before you can set up authenticator MFA.</Banner>
		{:else if !showMfaEnroll}
			{#if mySecurity?.mfaRequired}
				<Banner variant="warning">Your workspace requires authenticator MFA. Complete setup before your next sign-in.</Banner>
			{/if}
			<div class="flex items-center justify-between gap-3">
				<div class="text-sm text-[var(--color-text-muted)]">Not set up.</div>
				<Button variant="primary" size="sm" onclick={() => (showMfaEnroll = true)}>
					Set up authenticator app
				</Button>
			</div>
		{:else}
			<div class="space-y-3">
				{#if mySecurity?.mfaRequired}
					<Banner variant="warning">Your workspace requires authenticator MFA. Complete setup before your next sign-in.</Banner>
				{/if}
				<Field id="mfa-enable-password" type="password" label="Current password" autocomplete="current-password" bind:value={mfaPassword} placeholder="Confirm setup" />
				<div class="flex gap-2">
					<Button variant="primary" onclick={beginMfaEnrollment} disabled={mfaLoading || !mfaPassword}>
						{mfaLoading ? 'Starting…' : 'Continue'}
					</Button>
					<Button variant="secondary" onclick={() => { showMfaEnroll = false; mfaPassword = ''; mfaError = ''; }}>Cancel</Button>
				</div>
			</div>
		{/if}
	</Section>
{/if}

<Section first={isBot} title="Password" description="The password you use to sign in.">
	{#if passwordSuccess}<Banner variant="success">Password changed successfully.</Banner>{/if}

	{#if !passwordFormOpen}
		<Button variant="secondary" size="sm" onclick={() => { passwordFormOpen = true; passwordSuccess = false; }}>
			Change password
		</Button>
	{:else}
		{#if passwordError}<Banner variant="error">{passwordError}</Banner>{/if}
		<div class="space-y-3">
			<Field
				id="settings-current-password"
				type="password"
				label="Current password"
				autocomplete="current-password"
				bind:value={currentPassword}
				placeholder="Current password"
			/>
			<Field
				id="settings-new-password"
				type="password"
				label="New password"
				autocomplete="new-password"
				bind:value={newPassword}
				placeholder="At least 8 characters"
			/>
			<Field
				id="settings-confirm-password"
				type="password"
				label="Confirm new password"
				autocomplete="new-password"
				bind:value={confirmPassword}
				placeholder="Re-enter new password"
			/>
			<div class="flex gap-2">
				<Button
					variant="primary"
					onclick={handleChangePassword}
					disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
				>
					{passwordLoading ? 'Changing…' : 'Change password'}
				</Button>
				<Button variant="secondary" onclick={closePasswordForm}>Cancel</Button>
			</div>
		</div>
	{/if}
</Section>
