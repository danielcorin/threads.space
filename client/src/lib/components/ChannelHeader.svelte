<script lang="ts">
	import type { Channel } from '$lib/state/channels.svelte.js';
	import type { ConversationMode } from '$lib/state/ui.svelte.js';
	import type { Widget } from '$lib/api.js';
	import { presence } from '$lib/state/presence.svelte.js';
	import { FEEDBACK_CHANNEL_ID } from '$lib/constants.js';
	import List from 'phosphor-svelte/lib/List';
	import ListChecks from 'phosphor-svelte/lib/ListChecks';
	import Lock from 'phosphor-svelte/lib/Lock';
	import Hash from 'phosphor-svelte/lib/Hash';
	import ChatCircleDots from 'phosphor-svelte/lib/ChatCircleDots';
	import Robot from 'phosphor-svelte/lib/Robot';
	import FileText from 'phosphor-svelte/lib/FileText';
	import Users from 'phosphor-svelte/lib/Users';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece';
	import GearSix from 'phosphor-svelte/lib/GearSix';
	import Monitor from 'phosphor-svelte/lib/Monitor';
	import Cpu from 'phosphor-svelte/lib/Cpu';
	import Desktop from 'phosphor-svelte/lib/Desktop';
	import Gear from 'phosphor-svelte/lib/Gear';
	import Kanban from 'phosphor-svelte/lib/Kanban';
	import PushPin from 'phosphor-svelte/lib/PushPin';
	import NotePencil from 'phosphor-svelte/lib/NotePencil';
	import DotsThree from 'phosphor-svelte/lib/DotsThree';
	import Bug from 'phosphor-svelte/lib/Bug';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import { blurActiveInput } from '$lib/utils/blur.js';

	const iconMap: Record<string, typeof PuzzlePiece> = {
		PuzzlePiece,
		GearSix,
		Monitor,
		Cpu,
		Desktop,
		Gear,
		FileText,
		Users,
		Lock,
		Hash,
		List,
		MagnifyingGlass,
	};

	interface Props {
		channel: Channel | undefined;
		dmPartnerName?: string | null;
		dmPartnerId?: string | null;
		dmPartnerIsBot?: boolean;
		dmChannelId?: string | null;
		dmDisabledReason?: string | null;
		onopensettings: () => void;
		onopenMembers: () => void;
		onopensearch: () => void;
		ontoggleBoard: () => void;
		showBoardPanel: boolean;
		ontogglePins: () => void;
		showPinsPanel: boolean;
		pinCount?: number;
		ontoggleSavedDrafts: () => void;
		showSavedDraftsPanel: boolean;
		savedDraftsCount?: number;
		onopenSidebar: () => void;
		widgets?: Widget[];
		activeWidgetId?: string | null;
		ontoggleWidget?: (id: string) => void;
		onopenWidgetSplit?: (id: string) => void;
		memberCount?: number;
		canGoBack?: boolean;
		canGoForward?: boolean;
		ongoback?: () => void;
		ongoforward?: () => void;
		ontoggleDebug?: () => void;
		showDebugPanel?: boolean;
		conversationMode?: ConversationMode;
		ontoggleConversationMode?: () => void;
	}

	let { channel, dmPartnerName = null, dmPartnerId = null, dmPartnerIsBot = false, dmChannelId: _dmChannelId = null, dmDisabledReason: _dmDisabledReason = null, onopensettings, onopenMembers, onopensearch, ontoggleBoard, showBoardPanel, ontogglePins, showPinsPanel, pinCount = 0, ontoggleSavedDrafts, showSavedDraftsPanel, savedDraftsCount = 0, onopenSidebar, widgets = [], activeWidgetId = null, ontoggleWidget, onopenWidgetSplit, memberCount = 0, canGoBack = false, canGoForward = false, ongoback, ongoforward, ontoggleDebug, showDebugPanel = false, conversationMode = 'timeline', ontoggleConversationMode }: Props = $props();

	// The global feedback channel is locked: clicking its name/description must not
	// open the settings editor (also enforced server-side in handleUpdateChannel).
	let canEditSettings = $derived(!!channel && channel.id !== FEEDBACK_CHANNEL_ID);

	let showOverflowMenu = $state(false);
	function closeOverflow() {
		showOverflowMenu = false;
	}

	function handleWidgetClick(e: MouseEvent, widgetId: string) {
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			onopenWidgetSplit?.(widgetId);
			return;
		}
		ontoggleWidget?.(widgetId);
	}

	// Dismiss the virtual keyboard on any pointerdown inside the top bar.
	// Tapping the channel name, search, members, widgets, overflow dots, etc.
	// should blur the composer and drop the keyboard so the header action is
	// fully reachable without an intermediate tap-to-dismiss step.
	function handleHeaderPointerDown(e: PointerEvent) {
		const tgt = e.target as HTMLElement | null;
		// Never blur if the user is actually tapping into an editable field
		// inside the header (e.g. a future inline-rename input).
		if (tgt) {
			const tag = tgt.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt.isContentEditable) return;
		}
		blurActiveInput();
	}

</script>

<header
	class="h-12 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0"
	onpointerdown={handleHeaderPointerDown}
	role="presentation"
>
	{#snippet navButtons()}
		<button
			onclick={() => ongoback?.()}
			disabled={!canGoBack}
			class="hidden md:flex items-center justify-center w-6 h-6 rounded transition-colors {canGoBack ? 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] cursor-pointer' : 'text-[var(--color-text-muted)]/30 cursor-default'}"
			title="Go back"
		>
			<CaretLeft size={14} weight="bold" />
		</button>
		<button
			onclick={() => ongoforward?.()}
			disabled={!canGoForward}
			class="hidden md:flex items-center justify-center w-6 h-6 rounded transition-colors {canGoForward ? 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] cursor-pointer' : 'text-[var(--color-text-muted)]/30 cursor-default'}"
			title="Go forward"
		>
			<CaretRight size={14} weight="bold" />
		</button>
	{/snippet}

	{#if dmPartnerName}
		<div class="flex items-center gap-2">
			<button
				onclick={() => onopenSidebar()}
				class="md:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 mr-1 p-1"
				title="Open sidebar"
			>
				<List size={20} />
			</button>
			{@render navButtons()}
			<span class="font-semibold inline-flex items-center gap-1.5">
				{#if dmPartnerId}
					<span
						class="w-2 h-2 rounded-full shrink-0 {presence.isOnline(dmPartnerId) ? 'bg-green-500' : 'bg-[var(--color-text-muted)]/30'}"
						title={presence.isOnline(dmPartnerId) ? 'Online' : 'Offline'}
					></span>
				{/if}
				{#if dmPartnerIsBot}
					<Robot size={16} class="inline" />
				{:else}
					<ChatCircleDots size={16} class="inline" />
				{/if}
				{dmPartnerName}
			</span>
		</div>
	{:else if channel}
		<div class="flex items-center gap-2 min-w-0">
			<button
				onclick={() => onopenSidebar()}
				class="md:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 mr-1 p-1"
				title="Open sidebar"
			>
				<List size={20} />
			</button>
			{@render navButtons()}
			<svelte:element
				this={canEditSettings ? 'button' : 'span'}
				onclick={canEditSettings ? () => onopensettings() : undefined}
				title={channel.name}
				class="font-semibold truncate min-w-0 whitespace-nowrap {canEditSettings ? 'hover:text-[var(--color-text-muted)] transition-colors cursor-pointer' : ''}"
			>{#if channel.is_private}<Lock size={16} class="inline" />{:else}<Hash size={16} class="inline" />{/if} {channel.name}</svelte:element>
			{#if channel.description}
				<span class="text-sm text-[var(--color-text-muted)] hidden sm:inline">|</span>
				<svelte:element
					this={canEditSettings ? 'button' : 'span'}
					onclick={canEditSettings ? () => onopensettings() : undefined}
					class="text-sm text-[var(--color-text-muted)] hidden sm:inline truncate max-w-[300px] {canEditSettings ? 'hover:text-[var(--color-text)] transition-colors' : ''}"
				>
					{channel.description}
				</svelte:element>
			{/if}
		</div>
	{:else}
		<div class="flex items-center gap-2">
			<button
				onclick={() => onopenSidebar()}
				class="md:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 mr-1 p-1"
				title="Open sidebar"
			>
				<List size={20} />
			</button>
			{@render navButtons()}
			<span class="text-[var(--color-text-muted)]">Select a channel</span>
		</div>
	{/if}

	<div class="flex items-center gap-2">
		{#if (channel || dmPartnerName) && ontoggleConversationMode}
			<button
				type="button"
				onclick={() => ontoggleConversationMode?.()}
				class="flex items-center px-2 py-1.5 rounded transition-colors {conversationMode === 'tasks' ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}"
				title={conversationMode === 'tasks' ? 'Show conversation view' : 'Show task view'}
				aria-label={conversationMode === 'tasks' ? 'Show conversation view' : 'Show task view'}
				aria-pressed={conversationMode === 'tasks'}
			>
				<ListChecks size={18} />
			</button>
		{/if}
		{#if channel && !dmPartnerName}
			<!-- Desktop: show all action buttons -->
			{#each widgets as widget (widget.id)}
				{@const IconComponent = iconMap[widget.icon] ?? PuzzlePiece}
				<button
					onclick={(e) => handleWidgetClick(e, widget.id)}
					class="hidden md:flex items-center px-2 py-1.5 rounded transition-colors {activeWidgetId === widget.id ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}"
					title={`${widget.name} (⌘-click for split view)`}
				>
					<IconComponent size={16} />
				</button>
			{/each}
			{#if channel.board_enabled}
				<button
					onclick={() => ontoggleBoard()}
					class="hidden md:flex items-center px-2 py-1.5 rounded transition-colors {showBoardPanel ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}"
					title="Board"
				>
					<Kanban size={16} />
				</button>
			{/if}
			<button
				onclick={() => ontoggleSavedDrafts()}
				class="hidden md:flex items-center gap-1 px-2 py-1.5 rounded transition-colors {showSavedDraftsPanel ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}"
				title="Saved drafts"
			>
				<NotePencil size={16} />
				{#if savedDraftsCount > 0}
					<span class="text-xs">{savedDraftsCount}</span>
				{/if}
			</button>
			<button
				onclick={() => ontogglePins()}
				class="hidden md:flex items-center gap-1 px-2 py-1.5 rounded transition-colors {showPinsPanel ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}"
				title="Pinned messages"
			>
				<PushPin size={16} />
				{#if pinCount > 0}
					<span class="text-xs">{pinCount}</span>
				{/if}
			</button>
			<button
				onclick={() => onopenMembers()}
				class="hidden md:flex items-center gap-1 px-2 py-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				title="Members"
			>
				<Users size={16} />
				{#if memberCount > 0}
					<span class="text-xs">{memberCount}</span>
				{/if}
			</button>
			<button
				onclick={() => ontoggleDebug?.()}
				class="hidden md:flex items-center px-2 py-1.5 rounded transition-colors {showDebugPanel ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}"
				title="Debug info (Cmd+Shift+D)"
			>
				<Bug size={16} />
			</button>

			<!-- Mobile: Search and Members as visible icons -->
			<button
				onclick={() => onopensearch()}
				class="md:hidden flex items-center px-2 py-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				title="Search"
			>
				<MagnifyingGlass size={18} />
			</button>
			<button
				onclick={() => onopenMembers()}
				class="md:hidden flex items-center gap-1 px-2 py-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				title="Members"
			>
				<Users size={18} />
				{#if memberCount > 0}
					<span class="text-xs">{memberCount}</span>
				{/if}
			</button>

			<!-- Mobile: overflow menu for remaining actions -->
			<div class="relative md:hidden">
				<button
					onclick={() => (showOverflowMenu = !showOverflowMenu)}
					class="flex items-center px-2 py-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
					title="More actions"
				>
					<DotsThree size={20} weight="bold" />
				</button>
				{#if showOverflowMenu}
					<button type="button" class="fixed inset-0 z-40 cursor-default" onclick={closeOverflow} aria-label="Close actions menu"></button>
					<div class="absolute right-0 top-full mt-1 z-50 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg py-1 min-w-[180px]">
						<button
							onclick={() => { ontogglePins(); closeOverflow(); }}
							class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
						>
							<PushPin size={16} />
							<span>Pins</span>
							{#if pinCount > 0}
								<span class="text-xs text-[var(--color-text-muted)]">{pinCount}</span>
							{/if}
						</button>
						<button
							onclick={() => { ontoggleSavedDrafts(); closeOverflow(); }}
							class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
						>
							<NotePencil size={16} />
							<span>Saved drafts</span>
							{#if savedDraftsCount > 0}
								<span class="text-xs text-[var(--color-text-muted)]">{savedDraftsCount}</span>
							{/if}
						</button>
						{#if channel.board_enabled}
							<button
								onclick={() => { ontoggleBoard(); closeOverflow(); }}
								class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
							>
								<Kanban size={16} />
								<span>Board</span>
							</button>
						{/if}
						{#each widgets as widget (widget.id)}
							{@const IconComponent = iconMap[widget.icon] ?? PuzzlePiece}
							<button
								onclick={(e) => { handleWidgetClick(e, widget.id); closeOverflow(); }}
								class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
							>
								<IconComponent size={16} />
								<span>{widget.name}</span>
							</button>
						{/each}
						<div class="border-t border-[var(--color-border)] my-1"></div>
						<button
							onclick={() => { ontoggleDebug?.(); closeOverflow(); }}
							class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
						>
							<Bug size={16} />
							<span>Debug info</span>
						</button>
					</div>
				{/if}
			</div>
		{/if}
		<button
			onclick={() => onopensearch()}
			class="hidden md:flex items-center gap-2 px-3 py-1.5 rounded border border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] transition-colors"
		>
			<MagnifyingGlass size={16} />
			<span class="hidden sm:inline">Search</span>
			<kbd
				class="hidden sm:inline text-xs border border-[var(--color-border)] rounded px-1 py-0.5"
				>&#8984;K</kbd
			>
		</button>
	</div>
</header>
