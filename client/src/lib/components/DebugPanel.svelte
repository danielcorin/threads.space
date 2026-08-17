<script lang="ts">
	import { ui } from '$lib/state/ui.svelte.js';
	import { messages } from '$lib/state/messages.svelte.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import { dms } from '$lib/state/dms.svelte.js';
	import type { ThreadsSocket } from '$lib/ws.svelte.js';
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import X from 'phosphor-svelte/lib/X';
	import Copy from 'phosphor-svelte/lib/Copy';

	interface Props {
		ws: ThreadsSocket;
		channelMembers?: { user_id: string; username: string; display_name: string | null }[];
	}

	let { ws, channelMembers = [], embedded = false }: Props & { embedded?: boolean } = $props();

	// Collapsible sections — all expanded by default
	let wsOpen = $state(true);
	let syncOpen = $state(true);
	let roomOpen = $state(true);
	let cacheOpen = $state(true);
	let queueOpen = $state(true);

	// Live-updating "time since last event"
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(timer);
	});

	let copied = $state(false);

	const WS_STATE_LABELS: Record<number, string> = {
		[WebSocket.CONNECTING]: 'connecting',
		[WebSocket.OPEN]: 'open',
		[WebSocket.CLOSING]: 'closing',
		[WebSocket.CLOSED]: 'closed',
	};

	let wsStateLabel = $derived(WS_STATE_LABELS[ws.readyState] ?? 'unknown');

	let timeSinceLastEvent = $derived.by(() => {
		if (!ws.lastEventAt) return '—';
		const diff = Math.max(0, Math.floor((now - ws.lastEventAt) / 1000));
		if (diff < 60) return `${diff}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s ago`;
		return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`;
	});

	// Room identity
	let channel = $derived(channels.selected);
	let dm = $derived(dms.selected);
	let roomType = $derived.by(() => {
		if (dm) return 'DM';
		if (!channel) return '—';
		if (channel.is_ephemeral) return 'ephemeral';
		if (channel.is_private) return 'private';
		return 'channel';
	});

	// Message cache stats
	let msgList = $derived(messages.list);
	let cacheCount = $derived(msgList.length);
	let oldestMsg = $derived(msgList.length > 0 ? msgList[0] : null);
	let newestMsg = $derived(msgList.length > 0 ? msgList[msgList.length - 1] : null);

	function formatTs(ts: number): string {
		return new Date(ts * 1000).toLocaleString();
	}

	function handleClose() {
		if (ui.isMobile) {
			const screenWidth = window.innerWidth;
			ui.setPanelDragAnimating(true);
			ui.setPanelDragOffset(screenWidth);
			setTimeout(() => {
				ui.closeDebugPanel();
				ui.setPanelDragOffset(null);
				ui.setPanelDragAnimating(false);
			}, 200);
		} else {
			ui.closeDebugPanel();
		}
	}

	function buildDebugJson() {
		return {
			websocket: {
				state: wsStateLabel,
				url: ws.wsUrl,
				timeSinceLastEvent: timeSinceLastEvent,
				lastEventAt: ws.lastEventAt ? new Date(ws.lastEventAt).toISOString() : null,
				reconnectAttempts: ws.reconnectAttempts,
				lastCloseCode: ws.lastCloseCode,
				lastCloseReason: ws.lastCloseReason,
				pingRtt: ws.lastPingRtt != null ? `${ws.lastPingRtt}ms` : null,
				avgPingRtt: ws.avgPingRtt != null ? `${ws.avgPingRtt}ms` : null,
			},
			syncCursor: {
				channelId: messages.channelId,
				hasMore: messages.hasMore,
				loading: messages.loading,
				loadingMore: messages.loadingMore,
			},
			roomIdentity: {
				id: channel?.id ?? dm?.id ?? null,
				name: channel?.name ?? dm?.name ?? null,
				slug: channel?.name ?? null,
				type: roomType,
				is_ephemeral: channel?.is_ephemeral ?? null,
				auto_named_at: channel?.auto_named_at ?? null,
				archived_at: channel?.archived_at ?? null,
				auto_respond_bot_id: channel?.auto_respond_bot_id ?? null,
				is_private: channel?.is_private ?? null,
			},
			messageCache: {
				count: cacheCount,
				oldestId: oldestMsg?.id ?? null,
				oldestTimestamp: oldestMsg ? formatTs(oldestMsg.created_at) : null,
				newestId: newestMsg?.id ?? null,
				newestTimestamp: newestMsg ? formatTs(newestMsg.created_at) : null,
			},
		};
	}

	async function copyAsJson() {
		try {
			await navigator.clipboard.writeText(JSON.stringify(buildDebugJson(), null, 2));
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		} catch {
			// Fallback: select text
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
	class="debug-panel flex flex-col bg-[var(--color-bg-surface)] border-l border-[var(--color-border)] h-full overflow-hidden
		{embedded ? 'debug-panel-embedded' : ''}
		{ui.showDebugPanel ? 'debug-panel-open' : ''}
		{ui.panelDragAnimating ? 'debug-panel-animating' : ''}"
	style={ui.isMobile && (ui.panelDragAnimating || ui.panelDragOffset !== null)
		? `transform: translateX(${ui.panelDragOffset ?? 0}px);`
		: ''}
>
	<!-- Header -->
	<div class="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] shrink-0">
		<span class="text-sm font-semibold text-[var(--color-text)]">Debug Info</span>
		<button
			onclick={handleClose}
			class="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
		>
			<X size={16} />
		</button>
	</div>

	<!-- Scrollable content -->
	<div class="flex-1 overflow-y-auto p-3 space-y-1 text-xs font-mono" style="overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">

		<!-- 1. WebSocket -->
		<button class="section-toggle" onclick={() => wsOpen = !wsOpen}>
			{#if wsOpen}<CaretDown size={12} />{:else}<CaretRight size={12} />{/if}
			<span class="font-semibold text-[var(--color-text)]">WebSocket</span>
		</button>
		{#if wsOpen}
			<div class="section-body">
				<div class="debug-row">
					<span class="debug-label">State</span>
					<span class="debug-value">
						<span class="inline-block w-2 h-2 rounded-full mr-1 {ws.readyState === WebSocket.OPEN ? 'bg-green-500' : ws.readyState === WebSocket.CONNECTING ? 'bg-yellow-500' : 'bg-red-500'}"></span>
						{wsStateLabel}
					</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">URL</span>
					<span class="debug-value break-all">{ws.wsUrl ?? '—'}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Last event</span>
					<span class="debug-value">{timeSinceLastEvent}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Reconnects</span>
					<span class="debug-value">{ws.reconnectAttempts}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Last close</span>
					<span class="debug-value">
						{ws.lastCloseCode != null ? `${ws.lastCloseCode}` : '—'}
						{#if ws.lastCloseReason}
							<span class="text-[var(--color-text-muted)]">({ws.lastCloseReason})</span>
						{/if}
					</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Ping RTT</span>
					<span class="debug-value">
						{ws.lastPingRtt != null ? `${ws.lastPingRtt}ms` : '—'}
						{#if ws.avgPingRtt != null}
							<span class="text-[var(--color-text-muted)]">(avg {ws.avgPingRtt}ms)</span>
						{/if}
					</span>
				</div>
			</div>
		{/if}

		<!-- 2. Sync Cursor -->
		<button class="section-toggle" onclick={() => syncOpen = !syncOpen}>
			{#if syncOpen}<CaretDown size={12} />{:else}<CaretRight size={12} />{/if}
			<span class="font-semibold text-[var(--color-text)]">Sync Cursor</span>
		</button>
		{#if syncOpen}
			<div class="section-body">
				<div class="debug-row">
					<span class="debug-label">Channel ID</span>
					<span class="debug-value break-all">{messages.channelId ?? '—'}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Has more (backward)</span>
					<span class="debug-value">{messages.hasMore}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Loading</span>
					<span class="debug-value">{messages.loading}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Loading more</span>
					<span class="debug-value">{messages.loadingMore}</span>
				</div>
			</div>
		{/if}

		<!-- 3. Room Identity -->
		<button class="section-toggle" onclick={() => roomOpen = !roomOpen}>
			{#if roomOpen}<CaretDown size={12} />{:else}<CaretRight size={12} />{/if}
			<span class="font-semibold text-[var(--color-text)]">Room Identity</span>
		</button>
		{#if roomOpen}
			<div class="section-body">
				<div class="debug-row">
					<span class="debug-label">ID</span>
					<span class="debug-value break-all">{channel?.id ?? dm?.id ?? '—'}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Slug</span>
					<span class="debug-value">{channel?.name ?? dm?.name ?? '—'}</span>
				</div>
				<div class="debug-row">
					<span class="debug-label">Type</span>
					<span class="debug-value">{roomType}</span>
				</div>
				{#if channel}
					<div class="debug-row">
						<span class="debug-label">is_ephemeral</span>
						<span class="debug-value">{channel.is_ephemeral ?? 0}</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">auto_named_at</span>
						<span class="debug-value">{channel.auto_named_at != null ? formatTs(channel.auto_named_at) : '—'}</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">archived_at</span>
						<span class="debug-value">{channel.archived_at != null ? formatTs(channel.archived_at) : '—'}</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">auto_respond_bot_id</span>
						<span class="debug-value">{channel.auto_respond_bot_id ?? '—'}</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">is_private</span>
						<span class="debug-value">{channel.is_private}</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">board_enabled</span>
						<span class="debug-value">{channel.board_enabled}</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">processing_mode</span>
						<span class="debug-value">{channel.processing_mode}</span>
					</div>
				{/if}
				{#if dm}
					<div class="debug-row">
						<span class="debug-label">DM partner</span>
						<span class="debug-value">{dm.partner.username} ({dm.partner.id})</span>
					</div>
					<div class="debug-row">
						<span class="debug-label">Partner role</span>
						<span class="debug-value">{dm.partner.role ?? '—'}</span>
					</div>
				{/if}
				<div class="debug-row">
					<span class="debug-label">Members loaded</span>
					<span class="debug-value">{channelMembers.length}</span>
				</div>
			</div>
		{/if}

		<!-- 4. Message Cache -->
		<button class="section-toggle" onclick={() => cacheOpen = !cacheOpen}>
			{#if cacheOpen}<CaretDown size={12} />{:else}<CaretRight size={12} />{/if}
			<span class="font-semibold text-[var(--color-text)]">Message Cache</span>
		</button>
		{#if cacheOpen}
			<div class="section-body">
				<div class="debug-row">
					<span class="debug-label">Count loaded</span>
					<span class="debug-value">{cacheCount}</span>
				</div>
				{#if oldestMsg}
					<div class="debug-row">
						<span class="debug-label">Oldest</span>
						<span class="debug-value break-all">{oldestMsg.id}<br/><span class="text-[var(--color-text-muted)]">{formatTs(oldestMsg.created_at)}</span></span>
					</div>
				{/if}
				{#if newestMsg}
					<div class="debug-row">
						<span class="debug-label">Newest</span>
						<span class="debug-value break-all">{newestMsg.id}<br/><span class="text-[var(--color-text-muted)]">{formatTs(newestMsg.created_at)}</span></span>
					</div>
				{/if}
			</div>
		{/if}

		<!-- 5. Outbound Queue -->
		<button class="section-toggle" onclick={() => queueOpen = !queueOpen}>
			{#if queueOpen}<CaretDown size={12} />{:else}<CaretRight size={12} />{/if}
			<span class="font-semibold text-[var(--color-text)]">Outbound Queue</span>
		</button>
		{#if queueOpen}
			<div class="section-body">
				<div class="debug-row">
					<span class="debug-label">Pending sends</span>
					<span class="debug-value text-[var(--color-text-muted)]">0 (direct send, no queue)</span>
				</div>
			</div>
		{/if}
	</div>

	<!-- Copy as JSON -->
	<div class="shrink-0 border-t border-[var(--color-border)] p-3">
		<button
			onclick={copyAsJson}
			class="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)] transition-colors"
		>
			<Copy size={14} />
			{copied ? 'Copied!' : 'Copy as JSON'}
		</button>
	</div>
</div>

<style>
	.debug-panel {
		width: 22rem;
		max-width: 100%;
	}

	.debug-panel.debug-panel-embedded {
		width: 100%;
		border-left: 0;
		flex: 1;
		min-height: 0;
	}

	.section-toggle {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 0;
		cursor: pointer;
		color: var(--color-text);
		background: none;
		border: none;
		width: 100%;
		text-align: left;
	}

	.section-toggle:hover {
		color: var(--color-accent);
	}

	.section-body {
		padding: 2px 0 6px 16px;
	}

	.debug-row {
		display: flex;
		gap: 8px;
		padding: 2px 0;
		line-height: 1.4;
	}

	.debug-label {
		color: var(--color-text-muted);
		white-space: nowrap;
		flex-shrink: 0;
		min-width: 100px;
	}

	.debug-value {
		color: var(--color-text);
		word-break: break-all;
	}

	@media (max-width: 767px) {
		.debug-panel {
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			width: 100%;
			height: 100%;
			z-index: 55;
			border-left: none;
			transform: translateX(100%);
			transition: transform 200ms ease-out;
			will-change: transform;
			padding-top: env(safe-area-inset-top, 0px);
		}

		.debug-panel.debug-panel-open {
			transform: translateX(0);
		}

		.debug-panel.debug-panel-animating {
			transition: transform 200ms ease-out !important;
		}
	}
</style>
