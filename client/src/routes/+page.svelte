<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { api } from '$lib/api.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import { dms } from '$lib/state/dms.svelte.js';
	import { messages } from '$lib/state/messages.svelte.js';
	import { thread } from '$lib/state/thread.svelte.js';
	import { navigation } from '$lib/state/navigation.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import { modals } from '$lib/state/modals.svelte.js';
	import { drafts } from '$lib/state/drafts.svelte.js';
	import { folders } from '$lib/state/folders.svelte.js';
	import { presence } from '$lib/state/presence.svelte.js';
	import { events } from '$lib/state/events.svelte.js';
	import { inbox } from '$lib/state/inbox.svelte.js';
	import { updateBadge } from '$lib/badge.js';
	import { ThreadsSocket } from '$lib/ws.svelte.js';
	import { setupSwipeGesture } from '$lib/useSwipeGesture.js';
	import { ChannelSession } from '$lib/channelSession.js';
	import { NavigationController } from '$lib/navigationController.js';
	import { emojiPicker } from '$lib/state/emoji-picker.svelte.js';
	import { messageActions } from '$lib/state/message-actions.svelte.js';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import ThreadTaskList from '$lib/components/ThreadTaskList.svelte';
	import MessageComposer from '$lib/components/MessageComposer.svelte';
	import ThreadPanel from '$lib/components/ThreadPanel.svelte';
	import WidgetPanel from '$lib/components/WidgetPanel.svelte';
	import SplitWidgetPanel from '$lib/components/SplitWidgetPanel.svelte';
	import ResizableRightPanel from '$lib/components/ResizableRightPanel.svelte';
	import BoardPanel from '$lib/components/BoardPanel.svelte';
	import PinsPanel from '$lib/components/PinsPanel.svelte';
	import SavedDraftsPanel from '$lib/components/SavedDraftsPanel.svelte';
	import DebugPanel from '$lib/components/DebugPanel.svelte';
	import SearchPanel from '$lib/components/SearchPanel.svelte';
	import EmojiSheet from '$lib/components/EmojiSheet.svelte';
	import MessageActionSheet from '$lib/components/MessageActionSheet.svelte';
	import MemberManagement from '$lib/components/MemberManagement.svelte';
	import ChannelHeader from '$lib/components/ChannelHeader.svelte';
	import ChannelSettingsModal from '$lib/components/ChannelSettingsModal.svelte';
	import ProcessesPage from '$lib/components/ProcessesPage.svelte';
	import InboxPage from '$lib/components/InboxPage.svelte';
	import AgentOnboardingModal from '$lib/components/AgentOnboardingModal.svelte';
	import { processes } from '$lib/state/processes.svelte.js';
	import { pins } from '$lib/state/pins.svelte.js';
	import { savedDrafts } from '$lib/state/saved-drafts.svelte.js';
	import { hasSeenAgentOnboarding, markAgentOnboardingSeen } from '$lib/agentOnboarding.js';
	import {
		unreadNavigationDirection,
		type SidebarRevealRequest,
	} from '$lib/unreadNavigation.js';
	import type { Message } from '$lib/state/messages.svelte.js';
	import type { Widget } from '$lib/api.js';
	import CloudArrowUp from 'phosphor-svelte/lib/CloudArrowUp';
	import ChatCircle from 'phosphor-svelte/lib/ChatCircle';

	let ws = new ThreadsSocket();
	let typingUsers = $state<{ userId: string; username: string; threadId: string | null }[]>([]);
	let highlightMessageId = $state<string | null>(null);
	let channelMembers = $state<{ user_id: string; username: string; display_name: string | null }[]>([]);
	let knownUsernames = $derived(new Set(channelMembers.map(m => m.username)));
	let knownChannelNames = $derived(new Set(channels.list.map(c => c.name)));
	let editingMessage = $state<{ id: string; content: string } | null>(null);
	let channelWidgets = $state<Widget[]>([]);
	let dragOver = $state(false);
	let dragCounter = 0;
	let droppedFiles = $state<File[] | null>(null);
	let composerFocusCounter = $state(0);
	let loadedDraftContent = $state<string | null>(null);
	let sidebarRevealRequest = $state<SidebarRevealRequest | null>(null);
	let sidebarRevealRequestId = 0;

	// The active channel ID is either a regular channel or a DM channel
	let activeChannelId = $derived(channels.selectedId ?? dms.selectedId);
	let unreadBadgeCount = $derived(
		channels.list.reduce((sum, channel) => sum + (channel.unread_count || 0), 0) +
		dms.list.reduce((sum, dm) => sum + (dm.unread_count || 0), 0)
	);

	// Reconcile the installed-app icon whenever optimistic live counters or a
	// server-backed channel/DM reload changes the sidebar's canonical totals.
	$effect(() => {
		updateBadge(unreadBadgeCount);
	});

	// Typing is scoped: main-channel typers have threadId === null; thread typers
	// carry the parent message id of the open thread.
	let channelTypingUsers = $derived(typingUsers.filter((u) => u.threadId == null));
	let threadTypingUsers = $derived(
		thread.parentMessage
			? typingUsers.filter((u) => u.threadId === thread.parentMessage!.id)
			: []
	);

	const channelSession = new ChannelSession(ws, {
		activeChannelId: () => activeChannelId,
		isChannelSelected: () => !!channels.selectedId,
		typingUsers: () => typingUsers,
		setTypingUsers: (users) => { typingUsers = users; },
		channelMembers: () => channelMembers,
		setChannelMembers: (members) => { channelMembers = members; },
		setChannelWidgets: (widgets) => { channelWidgets = widgets; },
		setEditingDescription: (editing) => {
			if (editing) modals.open('channel-settings');
			else modals.close('channel-settings');
		},
		setEditingMessage: (message) => { editingMessage = message; },
		setHighlightMessageId: (id) => { highlightMessageId = id; },
	});
	const navController = new NavigationController({
		setHighlightMessageId: (id) => { highlightMessageId = id; },
	});

	let activeName = $derived.by(() => {
		if (channels.selected) return `#${channels.selected.name}`;
		const dm = dms.selected;
		if (dm) return dm.partner.display_name || dm.partner.username;
		return '';
	});

	// Push navigation entries when the top-level view, conversation, or thread changes.
	$effect(() => {
		navController.recordCurrentSelection({
			view: ui.currentView,
			channelId: channels.selectedId,
			dmId: dms.selectedId,
			threadMessageId: thread.open ? thread.parentMessage?.id ?? null : null
		});
	});

	function navigateToMessage(
		msgId: string,
		channelId?: string,
		isDm?: boolean,
		dmPartnerId?: string | null
	) {
		return navController.openMessage(msgId, channelId, isDm, dmPartnerId);
	}

	function handleDeepLinkClick(e: MouseEvent) {
		navController.handleDeepLinkClick(e);
	}


	function handleVisibilityChange() {
		channelSession.visibilityChanged();
		if (document.visibilityState === 'visible' && auth.loggedIn) {
			presence.reconnectIfNeeded();
			events.reconnectIfNeeded();
		}
	}

	function handleOnline() {
		channelSession.networkOnline();
		if (auth.loggedIn) {
			presence.reconnectIfNeeded();
			events.reconnectIfNeeded();
		}
	}

	// Clicks and keystrokes anywhere in the app mark this client "active" to the
	// server (over the always-connected presence socket, so it counts no matter
	// which channel — or none — is open). The server then withholds push
	// notifications for this user across all their devices. Stop interacting for
	// the idle window (60s) and the server treats us as away, so messages push to
	// our phone/other devices instead. Throttled inside sendActivity().
	function handleUserActivity() {
		if (auth.loggedIn) presence.sendActivity();
	}

	onMount(() => {
		if (auth.loggedIn) {
			if (new URL(window.location.href).searchParams.get('email_verified') === '1') {
				modals.open('user-settings');
			}
			channels.load();
			dms.load().then(() => {
				// Seed presence after DM list loads
				const partnerIds = dms.list.map((d) => d.partner.id).filter(Boolean);
				if (partnerIds.length > 0) presence.seed(partnerIds);
			});
			folders.load();
			drafts.load();
			processes.load();
			inbox.load();
			presence.connect();
			// Global event stream: drives unread badges (sidebar + app icon) for
			// channels the user isn't currently viewing.
			events.connect();
		}

		// Handle deep link URL params (?channel=X&msg=Y)
		if (auth.loggedIn) {
			navController.openInitialUrlSearch(window.location.search).catch(() => {});
		}

		// Handle deep links from push notification clicks (via service worker postMessage)
		function handleServiceWorkerMessage(event: MessageEvent) {
			if (!auth.loggedIn) return;
			navController.handleServiceWorkerMessage(event);
		}
		navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('online', handleOnline);
		// Capture phase so input still registers even if a handler stops propagation.
		// pointerdown (not click) so touch taps and scroll-starts on the mobile PWA
		// count as activity too — click can miss those.
		document.addEventListener('pointerdown', handleUserActivity, true);
		document.addEventListener('keydown', handleUserActivity, true);

		return () => {
			navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
			channelSession.dispose();
			presence.disconnect();
			events.disconnect();
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('online', handleOnline);
			document.removeEventListener('pointerdown', handleUserActivity, true);
			document.removeEventListener('keydown', handleUserActivity, true);
		};
	});

	// Swipe gesture handler for sidebar open/close and thread dismiss
	onMount(() => {
		return setupSwipeGesture();
	});

	// When a channel is selected, deselect any DM
	// (The reverse -- selecting a DM deselects channels -- is handled in dms.select())
	let _prevChannelId: string | null = null;
	$effect(() => {
		const cid = channels.selectedId;
		if (cid && cid !== _prevChannelId && dms.selectedId) {
			dms.select(null);
		}
		_prevChannelId = cid;
	});

	// When selected channel changes, delegate the selected conversation lifecycle
	// to ChannelSession. Only `activeChannelId` should be tracked — everything
	// else is a side effect that must not cause this effect to re-run.
	$effect(() => {
		const channelId = activeChannelId;
		untrack(() => {
			channelSession.open(channelId);
		});
	});

	async function handleSend(content: string, attachmentIds?: string[], metadata?: Record<string, unknown>, idempotencyKey?: string) {
		const channelId = activeChannelId;
		if (!channelId) return;
		const sendKey = idempotencyKey ?? crypto.randomUUID();
		const optimisticId = `~pending-${Date.now().toString(36)}-${sendKey}`;
		messages.addMessage({
			id: optimisticId,
			channel_id: channelId,
			user_id: auth.user?.id ?? null,
			content,
			thread_id: null,
			type: 'message',
			edited_at: null,
			deleted_at: null,
			created_at: Math.floor(Date.now() / 1000),
			username: auth.user?.username,
			display_name: auth.user?.display_name,
			name_color: auth.user?.name_color ?? null,
			avatar_url: auth.user?.avatar_url ?? null,
			reactions: [],
			attachments: [],
			metadata: metadata as Message['metadata'],
			client_delivery_status: 'sending',
			client_idempotency_key: sendKey
		});
		try {
			const sent = await messages.send(channelId, content, undefined, attachmentIds, metadata, sendKey);
			messages.replaceOptimisticMessage(optimisticId, {
				id: sent.id,
				channel_id: (sent as any).channelId ?? channelId,
				user_id: (sent as any).userId ?? auth.user?.id ?? null,
				content: sent.content,
				thread_id: (sent as any).threadId ?? null,
				type: 'message',
				edited_at: null,
				deleted_at: null,
				created_at: (sent as any).createdAt ?? Math.floor(Date.now() / 1000),
				username: (sent as any).username ?? auth.user?.username,
				display_name: (sent as any).displayName ?? auth.user?.display_name,
				name_color: (sent as any).nameColor ?? auth.user?.name_color ?? null,
				avatar_url: (sent as any).avatarUrl ?? auth.user?.avatar_url ?? null,
				reactions: [],
				attachments: sent.attachments ?? [],
				message_type: (sent as any).messageType ?? (sent as any).message_type,
				metadata: (sent as any).metadata ?? metadata as Message['metadata']
			});
		} catch (err) {
			console.error('Failed to send message:', err);
			messages.markMessageFailed(optimisticId);
		}
	}

	function handleStartEdit(message: Message) {
		editingMessage = { id: message.id, content: message.content || '' };
	}

	async function handleEditSubmit(messageId: string, content: string) {
		try {
			await messages.edit(messageId, content);
			messages.updateMessage(messageId, { content, edited_at: Date.now() / 1000 });
			editingMessage = null;
		} catch (err) {
			console.error('Failed to edit message:', err);
			// Re-throw so the composer stays in edit mode with the content intact
			throw err;
		}
	}

	function handleEditCancel() {
		editingMessage = null;
	}

	function handleReply(message: Message) {
		thread.openThread(message);
	}

	// Inline cancel from a message's processing chip. Cooperative: the server marks the
	// run killed and signals the bot (WS + webhook); the process_status broadcast then
	// clears the chip. Routed through the processes store so the Processes page stays in
	// sync too.
	async function handleProcessKill(_messageId: string, processId: string) {
		try {
			await processes.kill(processId);
		} catch (err) {
			console.error('Failed to cancel process:', err);
		}
	}

	async function handlePin(message: Message) {
		if (!activeChannelId) return;
		await pins.pin(activeChannelId, message.id);
	}

	async function handleUnpin(message: Message) {
		if (!activeChannelId) return;
		await pins.unpin(activeChannelId, message.id);
	}

	// Mark a thread resolved: optimistically dim it, revert if the request fails.
	// The WS echo (message_resolved) reconciles other clients and this one.
	async function handleResolve(message: Message) {
		messages.updateMessage(message.id, { resolved_at: Math.floor(Date.now() / 1000), resolved_by: auth.user?.id ?? null });
		try {
			await api.messages.resolve(message.id);
		} catch (err) {
			console.error('Failed to resolve message:', err);
			messages.updateMessage(message.id, { resolved_at: null, resolved_by: null });
		}
	}

	async function handleUnresolve(message: Message) {
		const prev = { resolved_at: message.resolved_at ?? null, resolved_by: message.resolved_by ?? null };
		messages.updateMessage(message.id, { resolved_at: null, resolved_by: null });
		try {
			await api.messages.unresolve(message.id);
		} catch (err) {
			console.error('Failed to unresolve message:', err);
			messages.updateMessage(message.id, prev);
		}
	}

	function handleToggleConversationMode() {
		ui.toggleConversationMode();
		thread.close();
		ui.closeCurrentPanel();
	}

	function handleOpenWidgetSplit(id: string) {
		if (ui.isMobile) return;
		thread.close();
		ui.openWidgetSplit(id);
	}

	function handleTogglePinsPanel() {
		if (!ui.isMobile) thread.close();
		ui.togglePinsPanel();
	}

	function handleToggleDebugPanel() {
		if (!ui.isMobile) thread.close();
		ui.toggleDebugPanel();
	}

	function handleToggleSavedDraftsPanel() {
		if (!ui.isMobile) thread.close();
		ui.toggleSavedDraftsPanel();
	}


	function handleChannelClick(channelName: string) {
		const target = channels.list.find(c => c.name === channelName);
		if (target) {
			channels.select(target.id);
		}
	}

	async function handleMentionClick(username: string) {
		// Close thread panel so the DM view is visible
		if (thread.open) {
			thread.close();
		}
		// Find the user ID from channel members first
		const member = channelMembers.find(m => m.username === username);
		if (member) {
			await dms.openDM(member.user_id);
			return;
		}
		// Fall back to user search
		try {
			const results = await api.users.search(username);
			const user = results.find((u: any) => u.username === username);
			if (user) {
				await dms.openDM(user.id);
			}
		} catch {
			// ignore
		}
	}

	function dismissTopOverlay() {
		// Any mutually-exclusive dialog modal (search, channel settings, members,
		// create/browse/new-dm/user-settings, agent onboarding) takes priority.
		if (modals.close()) {
			return true;
		}
		if (messageActions.isOpen) {
			messageActions.forceClose();
			return true;
		}
		if (emojiPicker.isOpen) {
			emojiPicker.close();
			return true;
		}
		if (ui.showPinsPanel) {
			ui.closePinsPanel();
			return true;
		}
		if (ui.showSavedDraftsPanel) {
			ui.closeSavedDraftsPanel();
			return true;
		}
		if (ui.showDebugPanel) {
			ui.closeDebugPanel();
			return true;
		}
		if (ui.hasOpenPanel) {
			ui.closeCurrentPanel();
			return true;
		}
		if (thread.open) {
			thread.close();
			composerFocusCounter++;
			return true;
		}
		if (ui.isMobile && ui.sidebarOpen) {
			ui.closeSidebar();
			return true;
		}
		return false;
	}

	function handleGlobalEscape(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (!dismissTopOverlay()) return;
		e.preventDefault();
		e.stopPropagation();
	}

	function handleKeydown(e: KeyboardEvent) {
		const unreadDirection = unreadNavigationDirection(e);
		if (unreadDirection !== null) {
			e.preventDefault();
			const target = navController.goToUnread(unreadDirection);
			if (target) {
				sidebarRevealRequest = {
					conversationId: target.id,
					requestId: ++sidebarRevealRequestId,
				};
			}
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			modals.toggle('search');
		}
		if (e.metaKey && !e.ctrlKey && e.key === 'e') {
			e.preventDefault();
			channels.createEphemeral();
		}
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'd' && activeChannelId) {
			e.preventDefault();
			handleToggleDebugPanel();
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
			e.preventDefault();
			composerFocusCounter++;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === '[') {
			e.preventDefault();
			navController.goBack();
		}
		if ((e.metaKey || e.ctrlKey) && e.key === ']') {
			e.preventDefault();
			navController.goForward();
		}
	}

	function openSettings() {
		modals.open('channel-settings');
	}

	function handleDismissAgentOnboarding() {
		modals.close('agent-onboarding');
	}

	$effect(() => {
		const user = auth.user;
		if (!user || !user.is_admin) {
			modals.close('agent-onboarding');
			return;
		}
		if (!hasSeenAgentOnboarding(user.id)) {
			markAgentOnboardingSeen(user.id);
			modals.open('agent-onboarding');
		}
	});

	// When a channel or DM is selected, switch to channels view and close mobile sidebar
	$effect(() => {
		if (channels.selectedId || dms.selectedId) {
			ui.setView('channels');
		}
		if (ui.isMobile) {
			ui.closeSidebar();
		}
	});

	// Lock body scroll when mobile sidebar is open.
	// Do NOT use position:fixed here — it changes the containing block for the
	// entire app and breaks the height:100dvh → flex redistribution that keeps
	// the composer visible when the iOS keyboard opens.
	// overflow:hidden is sufficient since html,body already have overflow:hidden
	// in app.css; this is a safety net for any edge cases.
	$effect(() => {
		if (typeof document === 'undefined') return;
		if (ui.isMobile && ui.sidebarOpen) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
		}
	});

	// VisualViewport-based keyboard detection is handled in ui.svelte.ts init().
	// It sets ui.viewportHeight which is applied as an inline style on the app-shell div.
	// iOS Safari ignores interactive-widget=resizes-content (Chromium-only),
	// so we need the visualViewport API to detect the keyboard and set explicit height.

	onMount(() => {
		document.addEventListener('keydown', handleGlobalEscape, { capture: true });
		return () => document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
	});

	// iOS Safari scrolls the document when focusing inputs inside fixed containers,
	// pushing the top bar off screen. Pin the scroll to 0,0 on mobile.
	onMount(() => {
		if (!window.matchMedia('(pointer: coarse)').matches) return;
		function resetScroll() {
			if (window.scrollX !== 0 || window.scrollY !== 0) {
				window.scrollTo(0, 0);
			}
		}
		window.addEventListener('scroll', resetScroll, { passive: true });
		return () => window.removeEventListener('scroll', resetScroll);
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="app-shell"
	style:height={ui.viewportHeight !== null ? `${ui.viewportHeight}px` : undefined}
	onclick={handleDeepLinkClick}
	onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleDeepLinkClick(e as unknown as MouseEvent); }}
	role="presentation"
>
	<Sidebar revealRequest={sidebarRevealRequest} />

	{#if ui.currentView === 'inbox'}
		<main class="flex-1 flex flex-col min-w-0 h-full min-h-0 overflow-hidden">
			<InboxPage
				onnavigatetomessage={(msgId, channelId, isDm, dmPartnerId) => {
					ui.setView('channels');
					navigateToMessage(msgId, channelId, isDm, dmPartnerId);
				}}
				onopensidebar={() => ui.openSidebar()}
			/>
		</main>
	{:else if ui.currentView === 'processes'}
		<main class="flex-1 flex flex-col min-w-0 h-full min-h-0 overflow-hidden">
			<ProcessesPage
				onnavigatetomessage={(msgId, channelId, isDm, dmPartnerId) => { navigateToMessage(msgId, channelId, isDm, dmPartnerId); }}
				onopensidebar={() => ui.openSidebar()}
			/>
		</main>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
		<main
			class="flex-1 flex flex-col min-w-0 h-full min-h-0 overflow-hidden relative"
			ondragenter={(e: DragEvent) => { e.preventDefault(); dragCounter++; dragOver = true; }}
			ondragover={(e: DragEvent) => { e.preventDefault(); }}
			ondragleave={() => { dragCounter--; if (dragCounter <= 0) { dragOver = false; dragCounter = 0; } }}
			ondrop={(e: DragEvent) => {
				e.preventDefault();
				dragOver = false;
				dragCounter = 0;
				const files = e.dataTransfer?.files;
				if (files && files.length > 0 && activeChannelId) {
					droppedFiles = Array.from(files);
				}
			}}
		>
			<ChannelHeader
				channel={channels.selected}
				dmPartnerName={dms.selected ? (dms.selected.partner.display_name || dms.selected.partner.username) : null}
				dmPartnerId={dms.selected?.partner.id ?? null}
				dmPartnerIsBot={dms.selected?.partner.role === 'bot' || dms.selected?.partner.bot_capabilities != null}
				dmChannelId={dms.selectedId ?? null}
				dmDisabledReason={dms.selected?.disabled_reason ?? null}
				onopensettings={openSettings}
				onopenMembers={() => modals.open('members')}
				onopensearch={() => modals.open('search')}
				ontoggleBoard={() => ui.toggleBoardPanel()}
				showBoardPanel={ui.showBoardPanel}
				ontogglePins={handleTogglePinsPanel}
				showPinsPanel={ui.showPinsPanel}
				pinCount={pins.list.length}
				ontoggleSavedDrafts={handleToggleSavedDraftsPanel}
				showSavedDraftsPanel={ui.showSavedDraftsPanel}
				savedDraftsCount={savedDrafts.list.length}
				onopenSidebar={() => ui.openSidebar()}
				widgets={channelWidgets}
				activeWidgetId={ui.activeWidgetId ?? ui.splitWidgetId}
				ontoggleWidget={(id) => ui.toggleWidget(id)}
				onopenWidgetSplit={handleOpenWidgetSplit}
				memberCount={channelMembers.length}
				canGoBack={navigation.canGoBack}
				canGoForward={navigation.canGoForward}
				ongoback={() => navController.goBack()}
				ongoforward={() => navController.goForward()}
				ontoggleDebug={handleToggleDebugPanel}
				showDebugPanel={ui.showDebugPanel}
				conversationMode={ui.conversationMode}
				ontoggleConversationMode={handleToggleConversationMode}
			/>

			{#if dragOver && activeChannelId}
				<div class="absolute inset-0 z-40 bg-[var(--color-accent)]/10 border-2 border-dashed border-[var(--color-accent)] flex items-center justify-center pointer-events-none rounded-lg m-2">
					<div class="text-center">
						<CloudArrowUp size={48} class="mx-auto mb-2 text-[var(--color-accent)]" />
						<p class="text-lg font-semibold text-[var(--color-accent)]">Drop files to upload</p>
					</div>
				</div>
			{/if}
			{#if activeChannelId}
				{#if channels.selected && ui.showBoardPanel}
					<div
						class="panel-swipe-container flex-1 flex flex-col min-h-0
							{ui.isDraggingPanel ? 'panel-dragging' : ''}
							{ui.panelDragAnimating ? 'panel-animating' : ''}"
						style={ui.isMobile && (ui.isDraggingPanel || ui.panelDragAnimating)
							? `transform: translateX(${ui.panelDragOffset ?? 0}px);`
							: ''}
					>
						<BoardPanel channelId={channels.selectedId!} />
					</div>
				{:else if channels.selected && ui.activeWidgetId}
					<div
						class="panel-swipe-container flex-1 flex flex-col min-h-0
							{ui.isDraggingPanel ? 'panel-dragging' : ''}
							{ui.panelDragAnimating ? 'panel-animating' : ''}"
						style={ui.isMobile && (ui.isDraggingPanel || ui.panelDragAnimating)
							? `transform: translateX(${ui.panelDragOffset ?? 0}px);`
							: ''}
					>
						<WidgetPanel widgetId={ui.activeWidgetId} channelId={channels.selectedId!} widgetName={channelWidgets.find(w => w.id === ui.activeWidgetId)?.name ?? 'Widget'} />
					</div>
				{:else}
				<div class="flex-1 flex flex-col min-h-0">
					{#if ui.conversationMode === 'tasks'}
						<ThreadTaskList
							items={messages.list}
							selectedAuthorKeys={activeChannelId ? ui.taskAuthorFilters[activeChannelId] ?? null : null}
							loading={messages.loading}
							loadError={messages.loadError}
							hasMore={messages.hasMore}
							loadingMore={messages.loadingMore}
							hasNewer={messages.hasNewer}
							loadingNewer={messages.loadingNewer}
							onopen={handleReply}
							onresolve={handleResolve}
							onunresolve={handleUnresolve}
							onretry={() => messages.retryLoad()}
							onloadmore={() => messages.loadMore()}
							onloadnewer={() => messages.loadNewer()}
							onauthorfilterchange={(authorKeys) => {
								if (activeChannelId) ui.setTaskAuthorFilter(activeChannelId, authorKeys);
							}}
						/>
					{:else}
						<MessageList onreply={handleReply} typingUsers={channelTypingUsers} {highlightMessageId} onclearHighlight={() => highlightMessageId = null} onprocesskill={handleProcessKill} {knownUsernames} {knownChannelNames} onchannelclick={handleChannelClick} onmentionclick={handleMentionClick} onstartedit={handleStartEdit} onnavigatetomessage={(msgId, channelId) => navigateToMessage(msgId, channelId)} onpin={handlePin} onunpin={handleUnpin} onresolve={handleResolve} onunresolve={handleUnresolve} />
					{/if}
					<MessageComposer
						onsend={handleSend}
						ontypingstart={() => ws.sendTypingStart()}
						ontypingstop={() => ws.sendTypingStop()}
						placeholder="Message {activeName}"
						focusTrigger={`${activeChannelId}-${composerFocusCounter}`}
						channelId={activeChannelId ?? undefined}
						members={channelMembers}
						channels={channels.list.map(c => ({ id: c.id, name: c.name }))}
						externalFiles={droppedFiles}
						onexternalfilesconsumed={() => { droppedFiles = null; }}
						availableModels={dms.selected?.partner?.bot_capabilities?.models ?? null}
						modelPickerKey={dms.selected?.partner?.id ?? null}
						defaultModel="z-ai/glm-5.1-20260406"
						disabledReason={dms.selected?.disabled_reason ?? null}
						{editingMessage}
						oneditsubmit={handleEditSubmit}
						oneditcancel={handleEditCancel}
						onsavedraft={async (content) => {
							const chId = activeChannelId;
							if (!chId) return;
							try {
								await savedDrafts.save(chId, content);
							} catch {
								// Error logged in state
							}
						}}
						loadedDraftContent={loadedDraftContent}
						onloadeddraftconsumed={() => { loadedDraftContent = null; }}
						loadDraft={async (cid) => {
							try {
								const result = await api.channels.getDraft(cid);
								return { content: result.content, attachments: result.attachments ?? [] };
							} catch {
								return { content: '', attachments: [] };
							}
						}}
						saveDraft={(cid, content, attachmentIds) => {
							drafts.set(cid, content.trim() !== '' || attachmentIds.length > 0);
							api.channels.saveDraft(cid, content, attachmentIds.length > 0 ? attachmentIds : undefined).catch(() => {});
						}}
					/>
				</div>
				{/if}
			{:else}
				<div class="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
					<div class="text-center">
						<div class="mb-2 flex justify-center"><ChatCircle size={48} /></div>
						<p>Welcome to Threads</p>
						<p class="text-sm mt-1">Select a channel to start chatting</p>
					</div>
				</div>
			{/if}
		</main>
	{/if}

	{#if channels.selected && ui.showPinsPanel && ui.isMobile}
		<PinsPanel channelId={channels.selectedId!} onnavigatetomessage={(msgId) => { ui.closePinsPanel(); navigateToMessage(msgId, channels.selectedId!); }} />
	{/if}

	{#if channels.selected && ui.showSavedDraftsPanel && ui.isMobile}
		<SavedDraftsPanel channelId={channels.selectedId!} onloaddraft={(content) => { loadedDraftContent = content; }} />
	{/if}

	{#if (channels.selected || dms.selected) && ui.showDebugPanel && ui.isMobile}
		<DebugPanel {ws} {channelMembers} />
	{/if}

	{#if thread.open}
		<ThreadPanel onprocesskill={handleProcessKill} {knownUsernames} {knownChannelNames} onchannelclick={handleChannelClick} onmentionclick={handleMentionClick} channels={channels.list.map(c => ({ id: c.id, name: c.name }))} members={channelMembers} onnavigatetomessage={(msgId, channelId) => { navigateToMessage(msgId, channelId); }} typingUsers={threadTypingUsers} ontypingstart={() => ws.sendTypingStart(thread.parentMessage?.id ?? null)} ontypingstop={() => ws.sendTypingStop(thread.parentMessage?.id ?? null)} />
	{:else if !ui.isMobile && (channels.selected || dms.selected) && ui.showDebugPanel}
		<ResizableRightPanel ariaLabel="Resize debug sidebar">
			<DebugPanel {ws} {channelMembers} embedded />
		</ResizableRightPanel>
	{:else if !ui.isMobile && channels.selected && ui.showPinsPanel}
		<ResizableRightPanel ariaLabel="Resize pinned messages sidebar">
			<PinsPanel channelId={channels.selectedId!} embedded onnavigatetomessage={(msgId) => { ui.closePinsPanel(); navigateToMessage(msgId, channels.selectedId!); }} />
		</ResizableRightPanel>
	{:else if !ui.isMobile && channels.selected && ui.showSavedDraftsPanel}
		<ResizableRightPanel ariaLabel="Resize saved drafts sidebar">
			<SavedDraftsPanel channelId={channels.selectedId!} embedded onloaddraft={(content) => { loadedDraftContent = content; }} />
		</ResizableRightPanel>
	{:else if channels.selected && ui.splitWidgetId && !ui.isMobile}
		<ResizableRightPanel ariaLabel="Resize widget sidebar">
			<SplitWidgetPanel widgetId={ui.splitWidgetId} channelId={channels.selectedId!} widgetName={channelWidgets.find(w => w.id === ui.splitWidgetId)?.name ?? 'Widget'} embedded />
		</ResizableRightPanel>
	{/if}

</div>

{#if modals.isOpen('search')}
	<SearchPanel onclose={() => modals.close('search')} onnavigatetomessage={(msgId, channelId, isDm, dmPartnerId) => navigateToMessage(msgId, channelId, isDm, dmPartnerId)} onchannelselect={() => composerFocusCounter++} />
{/if}

{#if modals.isOpen('channel-settings') && channels.selected}
	<ChannelSettingsModal
		channel={channels.selected}
		onclose={() => modals.close('channel-settings')}
		ondelete={async () => {
			const id = channels.selectedId!;
			modals.close('channel-settings');
			try {
				await channels.delete(id);
			} catch (err) {
				console.error('Failed to delete channel:', err);
				alert('Failed to delete channel. You may not have permission.');
			}
		}}
	/>
{/if}

<EmojiSheet />
<MessageActionSheet />

{#if modals.isOpen('members') && channels.selected}
	<MemberManagement
		channelId={channels.selected.id}
		isPrivate={!!channels.selected.is_private}
		onclose={() => modals.close('members')}
	/>
{/if}

{#if ui.debugMobile}
	<!-- Diagnostic overlay for iOS viewport/keyboard behavior.
	     Enable: add ?debug=vv to URL once, or set localStorage['threads.debug.vv']='1'.
	     Disable: localStorage.removeItem('threads.debug.vv') + reload. -->
	<div class="vv-debug" aria-hidden="true">
		<div>ih={ui.dbg.innerHeight} vv.h={ui.dbg.vvHeight} vv.ot={ui.dbg.vvOffsetTop} vv.ol={ui.dbg.vvOffsetLeft} vv.s={ui.dbg.vvScale}</div>
		<div>scrollY={ui.dbg.windowScrollY} vh={ui.viewportHeight ?? 'null'} focused={ui.dbg.focusedInput ? 'Y' : 'N'} active={ui.dbg.activeTag}</div>
		<div>n={ui.dbg.eventCount} last={ui.dbg.lastEvent}</div>
	</div>
{/if}

{#if modals.isOpen('agent-onboarding') && auth.user?.is_admin}
	<AgentOnboardingModal ondismiss={handleDismissAgentOnboarding} />
{/if}

<style>
	.vv-debug {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 99999;
		pointer-events: none;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10px;
		line-height: 1.25;
		padding: 2px 4px;
		background: rgba(0, 0, 0, 0.75);
		color: #0f0;
		white-space: nowrap;
		overflow: hidden;
	}
</style>
