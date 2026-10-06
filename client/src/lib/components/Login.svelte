<script lang="ts">
	import QRCode from 'qrcode';
	import { api } from '$lib/api.js';
	import type { MfaSetup } from '$lib/api.js';
	import { normalizeMfaCode } from '$lib/mfa-code.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import Spinner from './Spinner.svelte';
	import MfaSetupKey from './MfaSetupKey.svelte';

	type Step = 'credentials' | 'verify' | 'enroll';
	let step = $state<Step>('credentials');
	let username = $state('');
	let password = $state('');
	let code = $state('');
	let setup = $state<MfaSetup | null>(null);
	let qrCodeUrl = $state('');
	let error = $state('');
	let loading = $state(false);
	let usernameInput: HTMLInputElement | undefined = $state();

	function handleMfaCodeInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		code = normalizeMfaCode(input.value);
		input.value = code;
	}
	$effect(() => {
		usernameInput?.focus();
	});

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';
		loading = true;
		try {
			if (step === 'credentials') {
				if (!username.trim() || !password) return;
				const result = await auth.login(username.trim(), password);
				if (result.next === 'verify_mfa') {
					step = 'verify';
					password = '';
				} else if (result.next === 'enroll_mfa') {
					step = 'enroll';
					setup = result.setup;
					password = '';
					qrCodeUrl = await QRCode.toDataURL(result.setup.otpauthUri, {
						width: 220,
						margin: 1,
						color: { dark: '#111111', light: '#ffffff' }
					});
				}
			} else {
				if (!/^\d{6}$/.test(code)) {
					error = 'Enter the 6-digit code from your authenticator app';
					return;
				}
				await auth.completeMfa(code);
			}
		} catch (err: any) {
			error = err.message || 'Login failed';
		} finally {
			loading = false;
		}
	}

	async function startOver() {
		await api.cancelMfa().catch(() => undefined);
		step = 'credentials';
		code = '';
		setup = null;
		qrCodeUrl = '';
		error = '';
		setTimeout(() => usernameInput?.focus());
	}
</script>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
	<div class="w-full max-w-sm px-4">
		<div class="bg-[var(--color-bg-surface)] rounded-lg border border-[var(--color-border)] p-8">
			<h1 class="text-2xl font-bold mb-1">Threads</h1>
			<p class="text-[var(--color-text-muted)] text-sm mb-6">
				{step === 'credentials' ? 'Sign in to continue' : step === 'verify' ? 'Enter your authenticator code' : 'Set up your authenticator app'}
			</p>

			<form
				onsubmit={handleSubmit}
				class="space-y-4"
				method="post"
				action="/login"
				autocomplete="on"
				aria-label="Threads sign in"
			>
				{#if error}
					<div class="bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded px-3 py-2 text-sm text-[var(--color-danger)]">
						{error}
					</div>
				{/if}

				{#if step === 'credentials'}
				<div>
					<label for="username" class="block text-sm font-medium mb-1">Username</label>
					<input
						id="username"
						name="username"
						type="text"
						bind:this={usernameInput}
						bind:value={username}
						class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
						placeholder="Enter your username"
						autocomplete="username"
						autocapitalize="none"
						autocorrect="off"
						spellcheck="false"
					/>
				</div>

				<div>
					<label for="password" class="block text-sm font-medium mb-1">Password</label>
					<input
						id="password"
						name="password"
						type="password"
						bind:value={password}
						class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
						placeholder="Enter your password"
						autocomplete="current-password"
					/>
				</div>
				{:else}
					{#if step === 'enroll' && setup}
						<div class="space-y-3 text-sm">
							<p class="text-[var(--color-text-muted)]">Scan this code with 1Password, Google Authenticator, Authy, or another authenticator app.</p>
							{#if qrCodeUrl}
								<div class="flex justify-center rounded bg-white p-3"><img src={qrCodeUrl} alt="Authenticator setup QR code" width="220" height="220" /></div>
							{/if}
							<MfaSetupKey secret={setup.secret} />
						</div>
					{/if}

					<div>
						<label for="totp-code" class="block text-sm font-medium mb-1">6-digit code</label>
						<input
							id="totp-code"
							name="code"
							type="text"
							bind:value={code}
							oninput={handleMfaCodeInput}
							class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm tracking-[0.25em] focus:outline-none focus:border-[var(--color-accent)]"
							placeholder="000000"
							autocomplete="one-time-code"
							inputmode="numeric"
							pattern="[0-9]*"
							maxlength="6"
						/>
					</div>
				{/if}

				<button
					type="submit"
					disabled={loading || (step === 'credentials' ? !username.trim() || !password : !/^\d{6}$/.test(code))}
					class="w-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed rounded px-4 py-2 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
				>
					{#if loading}
						<Spinner />
						<span>{step === 'credentials' ? 'Signing in…' : 'Verifying…'}</span>
					{:else}
						{step === 'credentials' ? 'Sign in' : step === 'verify' ? 'Verify code' : 'Finish setup'}
					{/if}
				</button>
				{#if step !== 'credentials'}
					<button type="button" onclick={startOver} class="w-full text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Back to sign in</button>
				{/if}
			</form>
		</div>
	</div>
</div>
