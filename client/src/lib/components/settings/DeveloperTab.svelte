<script lang="ts">
	import { onMount } from 'svelte';
	import Copy from 'phosphor-svelte/lib/Copy';
	import Check from 'phosphor-svelte/lib/Check';
	import Trash from 'phosphor-svelte/lib/Trash';
	import { api } from '$lib/api.js';
	import Section from '../ui/Section.svelte';
	import Banner from '../ui/Banner.svelte';
	import Field from '../ui/Field.svelte';
	import Select from '../ui/Select.svelte';
	import Button from '../ui/Button.svelte';
	import ConfirmDialog from '../ConfirmDialog.svelte';
	import AgentIntegrationPanel from '../AgentIntegrationPanel.svelte';

	// API tokens.
	let tokenName = $state('');
	let tokenAccess = $state<'read' | 'read-write'>('read-write');
	let tokenExpiry = $state<'30' | '90' | '365' | 'never'>('90');
	let tokenError = $state('');
	let tokenLoading = $state(false);
	type ApiTokenScope = 'threads:read' | 'threads:write' | 'users:provision' | 'tokens:manage';
	type CreatedApiToken = {
		token: string;
		name: string;
		scopes: ApiTokenScope[];
		expires_at: number | null;
	};
	let createdToken = $state<CreatedApiToken | null>(null);
	let tokenCopied = $state(false);

	type ApiTokenSummary = {
		id: string;
		name: string;
		scopes: ApiTokenScope[];
		expires_at: number | null;
		created_at: number;
		last_used_at: number | null;
	};
	let tokens = $state<ApiTokenSummary[]>([]);
	let tokensLoading = $state(false);
	let tokensError = $state('');
	let revokingId = $state<string | null>(null);
	let confirmRevoke = $state<ApiTokenSummary | null>(null);

	async function loadTokens() {
		tokensError = '';
		tokensLoading = true;
		try {
			const result = await api.users.listApiTokens();
			tokens = result.tokens;
		} catch (err: any) {
			tokensError = err.message || 'Failed to load tokens';
		} finally {
			tokensLoading = false;
		}
	}

	async function handleCreateToken() {
		tokenError = '';

		if (!tokenName.trim()) {
			tokenError = 'Token name is required';
			return;
		}

		tokenLoading = true;
		try {
			const scopes: ApiTokenScope[] = tokenAccess === 'read'
				? ['threads:read']
				: ['threads:read', 'threads:write'];
			const expiresInDays = tokenExpiry === 'never' ? null : Number(tokenExpiry);
			const result = await api.users.createApiToken(tokenName.trim(), scopes, expiresInDays);
			createdToken = result;
			tokenCopied = false;
			tokenName = '';
			await loadTokens();
		} catch (err: any) {
			tokenError = err.message || 'Failed to create token';
		} finally {
			tokenLoading = false;
		}
	}

	async function revokeToken(id: string) {
		tokensError = '';
		revokingId = id;
		try {
			await api.users.revokeApiToken(id);
			tokens = tokens.filter((t) => t.id !== id);
		} catch (err: any) {
			tokensError = err.message || 'Failed to revoke token';
		} finally {
			revokingId = null;
		}
	}

	function formatTokenDate(createdAt: number): string {
		return new Date(createdAt * 1000).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function tokenAccessLabel(scopes: ApiTokenScope[]): string {
		if (scopes.includes('users:provision') || scopes.includes('tokens:manage')) return 'Admin automation';
		return scopes.includes('threads:write') ? 'Read/write' : 'Read only';
	}

	async function copyToken() {
		if (!createdToken) return;
		try {
			await navigator.clipboard.writeText(createdToken.token);
			tokenCopied = true;
			setTimeout(() => (tokenCopied = false), 2000);
		} catch {
			// Clipboard may be unavailable; the token stays visible to copy manually.
		}
	}

	onMount(loadTokens);
</script>

<Section
	first
	title="API tokens"
	description="Personal bearer tokens for the HTTP API, sent as Authorization: Bearer <token>. Each token is shown only once, when it is created."
>
	{#if tokenError}<Banner variant="error">{tokenError}</Banner>{/if}

	{#if createdToken}
		<div class="bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 rounded px-3 py-2 mb-3">
			<div class="text-xs text-[var(--color-text-muted)] mb-1">
				Token <span class="font-semibold text-[var(--color-text)]">{createdToken.name}</span> — copy it now, it won't be shown again.
			</div>
			<div class="text-xs text-[var(--color-text-muted)] mb-2">
				{tokenAccessLabel(createdToken.scopes)} · {createdToken.expires_at ? `Expires ${formatTokenDate(createdToken.expires_at)}` : 'No expiry'}
			</div>
			<div class="flex items-center gap-2">
				<input
					type="text"
					readonly
					value={createdToken.token}
					class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-xs font-mono focus:outline-none"
					onclick={(e: MouseEvent) => (e.currentTarget as HTMLInputElement).select()}
				/>
				<Button variant="secondary" onclick={copyToken} title="Copy token" class="shrink-0">
					{#if tokenCopied}<Check size={16} /> Copied{:else}<Copy size={16} /> Copy{/if}
				</Button>
			</div>
		</div>
	{/if}

	<div class="space-y-3">
		<Field id="admin-token-name" label="Token name" bind:value={tokenName} maxlength={100} placeholder="e.g. cli, ci, my-bot" />
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
			<Select id="admin-token-access" label="Access" bind:value={tokenAccess}>
				<option value="read">Read only</option>
				<option value="read-write">Read and write</option>
			</Select>
			<Select id="admin-token-expiry" label="Expiry" bind:value={tokenExpiry}>
				<option value="30">30 days</option>
				<option value="90">90 days</option>
				<option value="365">1 year</option>
				<option value="never">Never</option>
			</Select>
		</div>
		<Button variant="primary" onclick={handleCreateToken} disabled={tokenLoading || !tokenName.trim()}>
			{tokenLoading ? 'Creating…' : 'Create token'}
		</Button>
	</div>

	<div class="mt-5">
		<div class="text-xs font-semibold uppercase text-[var(--color-text-muted)] mb-2">Your tokens</div>
		{#if tokensError}<Banner variant="error">{tokensError}</Banner>{/if}
		{#if tokensLoading}
			<div class="text-sm text-[var(--color-text-muted)]">Loading…</div>
		{:else if tokens.length === 0}
			<div class="text-sm text-[var(--color-text-muted)]">No tokens yet.</div>
		{:else}
			<ul class="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded">
				{#each tokens as token (token.id)}
					<li class="flex items-center justify-between gap-3 px-3 py-2">
						<div class="min-w-0">
							<div class="text-sm font-medium truncate">{token.name}</div>
							<div class="text-xs text-[var(--color-text-muted)]">
								{tokenAccessLabel(token.scopes)} · Created {formatTokenDate(token.created_at)} · {token.last_used_at ? `Last used ${formatTokenDate(token.last_used_at)}` : 'Never used'} · {token.expires_at ? `Expires ${formatTokenDate(token.expires_at)}` : 'No expiry'}
							</div>
						</div>
						<Button
							variant="danger"
							size="xs"
							onclick={() => (confirmRevoke = token)}
							disabled={revokingId === token.id}
							title="Revoke token"
							class="shrink-0"
						>
							<Trash size={14} />
							{revokingId === token.id ? 'Revoking…' : 'Revoke'}
						</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</Section>

<Section title="API reference" description="Browse the HTTP API and try requests against this instance.">
	<a
		href="/docs"
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
	>
		Open API reference
	</a>
</Section>

<Section title="Agent integration">
	<AgentIntegrationPanel showHeader={false} />
</Section>

{#if confirmRevoke}
	<ConfirmDialog
		title="Revoke API token"
		message={`Revoke the token "${confirmRevoke.name}"? Any client using it will immediately stop working.`}
		warning="This cannot be undone."
		confirmLabel="Revoke"
		onconfirm={() => {
			const id = confirmRevoke!.id;
			confirmRevoke = null;
			revokeToken(id);
		}}
		oncancel={() => (confirmRevoke = null)}
	/>
{/if}
