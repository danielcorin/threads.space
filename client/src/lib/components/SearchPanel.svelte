<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import { dms } from '$lib/state/dms.svelte.js';
	import { formatTime } from '$lib/utils/time.js';
	import { renderSnippet } from '$lib/search.js';
	import { parse } from '$lib/searchSyntax.js';
	import {
		type Pill,
		pillFilters as computePillFilters,
		resolveDate,
		getCurrentToken as parseCurrentToken,
		resolveChannelId as resolveChannelIdAgainst,
		pillLabel as computePillLabel,
		resolveHistoryQueryIds
	} from '$lib/searchPills.js';
	import {
		getRecentSearches,
		addRecentSearch,
		removeRecentSearch,
		getSavedSearches,
		isSaved,
		toggleSavedSearch,
		setDisplayQuery,
		getDisplayQuery,
		getLastQuery,
		setLastQuery
	} from '$lib/searchHistory.js';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';
	import ChatCircleDots from 'phosphor-svelte/lib/ChatCircleDots';
	import Robot from 'phosphor-svelte/lib/Robot';
	import Clock from 'phosphor-svelte/lib/Clock';
	import Cpu from 'phosphor-svelte/lib/Cpu';
	import Hash from 'phosphor-svelte/lib/Hash';
	import Lock from 'phosphor-svelte/lib/Lock';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import Star from 'phosphor-svelte/lib/Star';
	import X from 'phosphor-svelte/lib/X';

	interface MessageResult {
		type: 'message';
		id: string;
		channel_id: string;
		content: string;
		snippet?: string | null;
		username: string;
		display_name: string | null;
		channel_name: string;
		is_dm?: number | boolean;
		dm_partner_id?: string | null;
		created_at: number;
	}

	interface ChannelResult {
		type: 'channel';
		id: string;
		name: string;
		description: string | null;
		is_private: number;
		is_dm: boolean;
		dm_partner_name?: string;
		is_bot?: boolean;
		has_unread: number;
		unread_count: number;
	}

	interface PageResult {
		type: 'page';
		id: string;
		name: string;
		description: string;
		action: () => void;
	}

	interface HistoryResult {
		type: 'history';
		id: string;
		query: string;
		source: 'saved' | 'recent';
	}

	type SearchItem = ChannelResult | MessageResult | PageResult | HistoryResult;

	interface Props {
		onclose: () => void;
		onnavigatetomessage?: (msgId: string, channelId: string, isDm?: boolean, dmPartnerId?: string | null) => void;
		onchannelselect?: () => void;
	}

	let { onclose, onnavigatetomessage, onchannelselect }: Props = $props();

	function handleClose() {
		// Flush any pending persist before closing
		if (persistTimeout) {
			clearTimeout(persistTimeout);
			persistTimeout = null;
		}
		setLastQuery({ query, pills: pills.map((p) => ({ key: p.key, value: p.value, raw: p.raw, displayValue: p.displayValue })) });
		onclose();
	}

	// --- Pill-based filter state ---
	let pills = $state<Pill[]>([]);

	let query = $state('');
	let messageResults = $state<MessageResult[]>([]);
	let messageTotal = $state(0);
	let messageHasMore = $state(false);
	let messageLoading = $state(false);
	let messageLoadingMore = $state(false);
	let messageSearched = $state(false);
	let searchTimeout: ReturnType<typeof setTimeout> | null = null;
	let searchInput: HTMLInputElement | undefined = $state();
	let selectedIndex = $state(0);
	let recentSearches = $state<string[]>([]);
	let savedSearches = $state<string[]>([]);
	// eslint-disable-next-line svelte/prefer-writable-derived
	let currentQuerySaved = $state(false);
	let restoredSearchClearArmed = $state(false);

	// --- Autocomplete state ---
	let acOpen = $state(false);
	let acItems = $state<Array<{ label: string; value: string; detail?: string }>>([]);
	let acSelectedIndex = $state(0);
	let acOperator = $state(''); // current operator being autocompleted
	let acTimeout: ReturnType<typeof setTimeout> | null = null;

	// Date presets for before:/after: autocomplete
	const DATE_PRESETS = [
		{ label: 'Yesterday', value: 'yesterday' },
		{ label: '7 days ago', value: '7d' },
		{ label: '30 days ago', value: '30d' },
		{ label: '90 days ago', value: '90d' },
	];

	const HAS_OPTIONS = [
		{ label: 'link', value: 'link', detail: 'Messages with URLs' },
		{ label: 'reaction', value: 'reaction', detail: 'Messages with reactions' },
		{ label: 'file', value: 'file', detail: 'Messages with attachments' },
	];

	// Pure pill/filter helpers live in $lib/searchPills.ts; these thin wrappers
	// bind them to the channel/DM stores.
	function pillFilters(): Record<string, string> {
		return computePillFilters(pills);
	}

	// Resolve channel name → id for API
	function resolveChannelId(name: string): string {
		return resolveChannelIdAgainst(name, channels.list, dms.list);
	}

	// Resolve from username → id for API
	function resolveUserId(name: string): string {
		// We store the user id directly when selected from autocomplete
		return name;
	}

	function buildSearchOpts() {
		const f = pillFilters();
		const opts: Record<string, any> = {};
		if (f.channel) opts.channelId = resolveChannelId(f.channel);
		if (f.from) opts.fromUserId = resolveUserId(f.from);
		if (f.since) opts.since = Number(resolveDate(f.since));
		if (f.until) opts.until = Number(resolveDate(f.until));
		if (f.has) opts.has = f.has;
		return opts;
	}

	// --- Derived: check if current text being typed is a partial operator ---
	function getCurrentToken(): { prefix: string; value: string } | null {
		return parseCurrentToken(query);
	}

	let hasActiveFilter = $derived(pills.length > 0);

	function pillLabel(p: Pill): string {
		return computePillLabel(p, channels.list, dms.list);
	}

	function removePill(index: number) {
		pills = pills.filter((_, i) => i !== index);
		searchInput?.focus();
		persistQuery();
		triggerSearch();
	}

	function addPill(key: string, value: string, displayValue?: string) {
		// Remove existing pill with same key (except has: which can combine)
		if (key !== 'has') {
			pills = pills.filter((p) => p.key !== key);
		}
		// Auto-resolve displayValue for in:/from: when caller didn't provide one
		// (e.g. typed-id paths at lines ~642 and ~674).
		let resolved = displayValue;
		if (!resolved) {
			if (key === 'in') {
				const ch = channels.list.find((c) => c.id === value);
				if (ch) resolved = ch.name;
			} else if (key === 'from') {
				const dm = dms.list.find((d) => d.partner.id === value);
				if (dm) resolved = dm.partner.display_name || dm.partner.username;
			}
		}
		pills = [...pills, { key, value, raw: `${key}:${value}`, displayValue: resolved }];
		persistQuery();
	}

	// Resolve any unresolved in:ID / from:ID fragments in a stored history query
	// against current channel/user state. Falls back to getDisplayQuery's stored map.
	function formatHistoryQuery(raw: string): string {
		return resolveHistoryQueryIds(getDisplayQuery(raw), channels.list, dms.list);
	}

	// --- Autocomplete logic ---
	function updateAutocomplete() {
		const tok = getCurrentToken();
		if (!tok) {
			closeAutocomplete();
			return;
		}

		acOperator = tok.prefix;
		const val = tok.value.toLowerCase();

		if (tok.prefix === 'in') {
			// Channel typeahead. Archived ephemeral channels remain searchable by message
			// content but are hidden from default name/typeahead results until restored.
			const items: typeof acItems = [];
			for (const ch of channels.list) {
				if (ch.is_ephemeral && ch.archived_at) continue;
				if (!val || ch.name.toLowerCase().includes(val)) {
					items.push({ label: `#${ch.name}`, value: ch.id, detail: ch.description || undefined });
				}
			}
			for (const dm of dms.list) {
				const name = dm.partner.display_name || dm.partner.username;
				if (!val || name.toLowerCase().includes(val)) {
					items.push({ label: `@${name}`, value: dm.id, detail: 'DM' });
				}
			}
			acItems = items.slice(0, 10);
			acOpen = acItems.length > 0;
			acSelectedIndex = 0;
		} else if (tok.prefix === 'from') {
			// User typeahead (debounced API call)
			if (acTimeout) clearTimeout(acTimeout);
			acTimeout = setTimeout(async () => {
				try {
					// Pass empty string to get default/all users when no query typed yet
					const results = (await api.users.search(val)) as Array<{
						id: string;
						username: string;
						display_name: string | null;
					}>;
					acItems = results.map((u) => ({
						label: u.display_name || u.username,
						value: u.id,
						detail: `@${u.username}`,
					}));
					acOpen = acItems.length > 0;
					acSelectedIndex = 0;
				} catch {
					closeAutocomplete();
				}
			}, val ? 200 : 0);
		} else if (tok.prefix === 'before' || tok.prefix === 'after') {
			acItems = DATE_PRESETS.filter(
				(d) => !val || d.label.toLowerCase().includes(val) || d.value.includes(val)
			);
			acOpen = acItems.length > 0;
			acSelectedIndex = 0;
		} else if (tok.prefix === 'has') {
			acItems = HAS_OPTIONS.filter(
				(h) => !val || h.label.includes(val) || h.value.includes(val)
			);
			acOpen = acItems.length > 0;
			acSelectedIndex = 0;
		} else {
			closeAutocomplete();
		}
	}

	function closeAutocomplete() {
		acOpen = false;
		acItems = [];
		acOperator = '';
		acSelectedIndex = 0;
	}

	function selectAutocompleteItem(item: { label: string; value: string }) {
		const tok = getCurrentToken();
		if (!tok) return;

		let pillValue = item.value;
		let pillDisplayValue: string | undefined;

		if (tok.prefix === 'from') {
			pillDisplayValue = item.label; // human-readable name
			pillValue = item.value; // user ID
		} else if (tok.prefix === 'in') {
			pillDisplayValue = item.label.replace(/^[#@]/, '');
			pillValue = item.value; // channel ID
		}

		// Remove the current partial token from query
		const parts = query.trimEnd().split(/\s+/);
		parts.pop(); // remove the partial operator token
		query = parts.join(' ') + (parts.length > 0 ? ' ' : '');

		addPill(tok.prefix, pillValue, pillDisplayValue);
		closeAutocomplete();
		searchInput?.focus();
		triggerSearch();
	}

	function refreshHistory() {
		recentSearches = getRecentSearches();
		savedSearches = getSavedSearches();
	}

	// Static pages / views
	const pages: PageResult[] = [];

	// For filtering pages/channels, use only the free-text portion (not operators)
	let freeTextQuery = $derived.by(() => {
		const parsed = parse(query);
		return parsed.freeText.trim().toLowerCase();
	});

	let filteredPages = $derived.by(() => {
		const q = freeTextQuery;
		if (!q) return pages;
		return pages.filter(
			(p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
		);
	});

	let dmNameById = $derived.by(() => {
		const map = new Map<string, string>();
		for (const dm of dms.list) {
			map.set(dm.id, dm.partner.display_name || dm.partner.username);
		}
		return map;
	});

	let filteredChannels = $derived.by(() => {
		const q = freeTextQuery;
		const items: ChannelResult[] = [];

		for (const ch of channels.list) {
			if (ch.is_ephemeral && ch.archived_at) continue;
			if (!q || ch.name.toLowerCase().includes(q) || ch.description?.toLowerCase().includes(q)) {
				items.push({
					type: 'channel',
					id: ch.id,
					name: ch.name,
					description: ch.description,
					is_private: ch.is_private,
					is_dm: false,
					has_unread: ch.has_unread,
					unread_count: ch.unread_count
				});
			}
		}

		for (const dm of dms.list) {
			const partnerName = dm.partner.display_name || dm.partner.username;
			if (!q || partnerName.toLowerCase().includes(q) || dm.partner.username.toLowerCase().includes(q)) {
				items.push({
					type: 'channel',
					id: dm.id,
					name: dm.name,
					description: dm.last_message_content,
					is_private: 1,
					is_dm: true,
					dm_partner_name: partnerName,
					is_bot: dm.partner.role === 'bot' || dm.partner.bot_capabilities != null,
					has_unread: dm.has_unread,
					unread_count: dm.unread_count
				});
			}
		}

		if (!q) {
			items.sort((a, b) => {
				if (a.has_unread !== b.has_unread) return b.has_unread - a.has_unread;
				const aName = a.is_dm ? a.dm_partner_name! : a.name;
				const bName = b.is_dm ? b.dm_partner_name! : b.name;
				return aName.localeCompare(bName);
			});
		}

		return items;
	});

	let allItems = $derived.by(() => {
		if (hasActiveFilter) {
			return [...messageResults, ...historyItems, ...filteredPages, ...filteredChannels] as SearchItem[];
		}
		const items: SearchItem[] = [...historyItems, ...filteredPages, ...filteredChannels];
		if (messageResults.length > 0) {
			items.push(...messageResults);
		}
		return items;
	});

	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		allItems.length;
		selectedIndex = 0;
	});

	let persistTimeout: ReturnType<typeof setTimeout> | null = null;

	function persistQuery() {
		if (persistTimeout) clearTimeout(persistTimeout);
		persistTimeout = setTimeout(() => {
			setLastQuery({ query, pills: pills.map((p) => ({ key: p.key, value: p.value, raw: p.raw, displayValue: p.displayValue })) });
		}, 300);
	}

	function focusSearchInput(selectQuery = false) {
		searchInput?.focus();
		if (selectQuery && searchInput && query.length > 0) {
			// Wait until the input is focused and hydrated before selecting the restored query.
			requestAnimationFrame(() => searchInput?.select());
		}
	}

	function clearActiveSearch() {
		if (searchTimeout) {
			clearTimeout(searchTimeout);
			searchTimeout = null;
		}
		if (persistTimeout) {
			clearTimeout(persistTimeout);
			persistTimeout = null;
		}
		query = '';
		pills = [];
		messageResults = [];
		messageTotal = 0;
		messageHasMore = false;
		messageSearched = false;
		closeAutocomplete();
		setLastQuery({ query: '', pills: [] });
	}

	onMount(() => {
		let restoredQuery = false;
		// Hydrate last query from localStorage (only when no explicit query)
		if (!query && pills.length === 0) {
			const last = getLastQuery();
			if (last) {
				query = last.query;
				pills = last.pills;
				restoredQuery = query.length > 0;
				restoredSearchClearArmed = query.trim().length > 0 || pills.length > 0;
				if (query.trim() || pills.length > 0) {
					tick().then(() => doMessageSearch(false));
				}
			}
		}
		focusSearchInput(restoredQuery);
		refreshHistory();
	});

	let historyItems = $derived.by(() => {
		if (query.trim()) return [] as HistoryResult[];
		const items: HistoryResult[] = [];
		for (const q of savedSearches) {
			items.push({ type: 'history', id: `saved:${q}`, query: q, source: 'saved' });
		}
		for (const q of recentSearches) {
			if (savedSearches.includes(q)) continue;
			items.push({ type: 'history', id: `recent:${q}`, query: q, source: 'recent' });
		}
		return items;
	});

	$effect(() => {
		currentQuerySaved = isSaved(query);
	});

	function triggerSearch() {
		if (searchTimeout) clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => doMessageSearch(false), 100);
	}

	function handleInput() {
		restoredSearchClearArmed = false;
		if (searchTimeout) clearTimeout(searchTimeout);
		updateAutocomplete();
		persistQuery();

		if (!query.trim() && pills.length === 0) {
			messageResults = [];
			messageTotal = 0;
			messageHasMore = false;
			messageSearched = false;
			return;
		}
		searchTimeout = setTimeout(() => doMessageSearch(false), 300);
	}

	async function doMessageSearch(append: boolean) {
		// Parse the current query to extract any inline operators not yet pill-ified
		const parsed = parse(query);
		const freeText = parsed.freeText.trim();

		// If no free text and no pills, nothing to search
		if (!freeText && pills.length === 0) return;

		if (append) {
			messageLoadingMore = true;
		} else {
			messageLoading = true;
			messageSearched = true;
		}
		try {
			const offset = append ? messageResults.length : 0;

			// Merge pill filters with any inline operator filters from text
			const pillOpts = buildSearchOpts();
			const inlineFilters = parsed.filters;

			const opts: Record<string, any> = { offset, ...pillOpts };

			// Inline filters override pills (they're more recent)
			if (inlineFilters.channel && !opts.channelId) opts.channelId = resolveChannelId(inlineFilters.channel);
			if (inlineFilters.from && !opts.fromUserId) opts.fromUserId = inlineFilters.from;
			if (inlineFilters.since && !opts.since) opts.since = Number(resolveDate(inlineFilters.since));
			if (inlineFilters.until && !opts.until) opts.until = Number(resolveDate(inlineFilters.until));
			if (inlineFilters.has && !opts.has) opts.has = inlineFilters.has;

			// Use free text as the search query; if empty, use '*' to match all (when filters exist)
			const searchQuery = freeText || '*';

			const raw = await api.search(searchQuery, opts);
			if (!append && freeText !== parse(query).freeText.trim()) return;
			const mapped = raw.results.map((r: any) => ({ ...r, type: 'message' as const })) as MessageResult[];
			messageResults = append ? [...messageResults, ...mapped] : mapped;
			messageTotal = raw.total;
			messageHasMore = raw.hasMore;
		} catch {
			if (!append) {
				messageResults = [];
				messageTotal = 0;
				messageHasMore = false;
			}
		} finally {
			if (append) messageLoadingMore = false;
			else messageLoading = false;
		}
	}

	function loadMoreMessages() {
		if (!messageHasMore || messageLoadingMore) return;
		doMessageSearch(true);
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || e.key !== 'Escape') return;
		e.preventDefault();
		handleClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		// Autocomplete navigation
		if (acOpen) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				acSelectedIndex = (acSelectedIndex + 1) % acItems.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				acSelectedIndex = (acSelectedIndex - 1 + acItems.length) % acItems.length;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				if (acItems[acSelectedIndex]) {
					selectAutocompleteItem(acItems[acSelectedIndex]);
				}
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				closeAutocomplete();
				return;
			}
		}

		if (e.key === 'Escape') {
			handleClose();
			return;
		}

		if (restoredSearchClearArmed) {
			restoredSearchClearArmed = false;
			if (e.key === 'Backspace') {
				e.preventDefault();
				clearActiveSearch();
				return;
			}
		}

		// Backspace at start of input deletes last pill
		if (e.key === 'Backspace' && query === '' && pills.length > 0) {
			pills = pills.slice(0, -1);
			triggerSearch();
			return;
		}

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (allItems.length > 0) {
				selectedIndex = (selectedIndex + 1) % allItems.length;
				scrollSelectedIntoView();
			}
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (allItems.length > 0) {
				selectedIndex = (selectedIndex - 1 + allItems.length) % allItems.length;
				scrollSelectedIntoView();
			}
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			// Check if current text contains a complete operator (e.g. after typing "in:general ")
			const tok = getCurrentToken();
			if (tok && tok.value) {
				// Complete the operator as a pill
				const parts = query.trimEnd().split(/\s+/);
				parts.pop();
				query = parts.join(' ') + (parts.length > 0 ? ' ' : '');
				addPill(tok.prefix, tok.value);
				closeAutocomplete();
				triggerSearch();
				return;
			}

			const item = allItems[selectedIndex];
			if (item) {
				selectItem(item);
			} else if (query.trim() || pills.length > 0) {
				if (searchTimeout) clearTimeout(searchTimeout);
				doMessageSearch(false);
			}
			return;
		}
	}

	function scrollSelectedIntoView() {
		requestAnimationFrame(() => {
			const el = document.querySelector(`[data-search-index="${selectedIndex}"]`);
			el?.scrollIntoView({ block: 'nearest' });
		});
	}

	function selectItem(item: SearchItem) {
		if (item.type === 'history') {
			query = item.query;
			// Re-parse the history query to extract pills
			const parsed = parse(item.query);
			pills = [];
			for (const tok of parsed.tokens) {
				if (tok.type === 'operator') {
					addPill(tok.key, tok.value);
				}
			}
			query = parsed.freeText;
			searchInput?.focus();
			if (searchTimeout) clearTimeout(searchTimeout);
			doMessageSearch(false);
			return;
		}
		if (item.type === 'page') {
			item.action();
		} else if (item.type === 'channel') {
			if (item.is_dm) {
				dms.select(item.id);
			} else {
				channels.select(item.id);
			}
			// Always signal selection so the composer re-focuses even when the
			// chosen channel is already open (activeChannelId unchanged →
			// focusTrigger wouldn't change on its own).
			onchannelselect?.();
		} else {
			if (onnavigatetomessage) {
				onnavigatetomessage(item.id, item.channel_id, item.is_dm === 1 || item.is_dm === true, item.dm_partner_id ?? null);
			} else {
				channels.select(item.channel_id);
			}
		}
		// Record full query (pills + free text) in history
		const fullQuery = [...pills.map((p) => p.raw), query.trim()].filter(Boolean).join(' ');
		if (fullQuery) {
			addRecentSearch(fullQuery);
			// Store display version for history rendering
			const displayParts = pills.map((p) => `${p.key}:${pillLabel(p).replace(/^[#@]/, '')}`);
			const displayQuery = [...displayParts, query.trim()].filter(Boolean).join(' ');
			if (displayQuery !== fullQuery) {
				setDisplayQuery(fullQuery, displayQuery);
			}
			refreshHistory();
		}
		handleClose();
	}

	function handleRemoveRecent(e: MouseEvent, q: string) {
		e.stopPropagation();
		removeRecentSearch(q);
		refreshHistory();
	}

	function handleToggleSaved(e: MouseEvent | undefined, q: string) {
		e?.stopPropagation();
		const trimmed = q.trim();
		if (!trimmed) return;
		toggleSavedSearch(trimmed);
		refreshHistory();
		currentQuerySaved = isSaved(trimmed);
	}

	function getFullQuery(): string {
		return [...pills.map((p) => p.raw), query.trim()].filter(Boolean).join(' ');
	}

	function sectionOffset(section: 'messages' | 'saved' | 'recent' | 'pages' | 'channels'): number {
		const savedCount = historyItems.filter((h) => h.source === 'saved').length;
		if (hasActiveFilter) {
			const msgCount = messageResults.length;
			switch (section) {
				case 'messages': return 0;
				case 'saved': return msgCount;
				case 'recent': return msgCount + savedCount;
				case 'pages': return msgCount + historyItems.length;
				case 'channels': return msgCount + historyItems.length + filteredPages.length;
			}
		} else {
			switch (section) {
				case 'saved': return 0;
				case 'recent': return savedCount;
				case 'pages': return historyItems.length;
				case 'channels': return historyItems.length + filteredPages.length;
				case 'messages': return historyItems.length + filteredPages.length + filteredChannels.length;
			}
		}
	}

	function itemIndex(offset: number, i: number): number {
		return offset + i;
	}

</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
	class="fixed inset-0 bg-black/50 flex items-start justify-center pt-0 md:pt-16 z-50"
	onclick={handleClose}
	onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); }}
	role="button"
	tabindex="0"
>
	<div
		class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] md:rounded-lg w-full max-w-none md:max-w-2xl lg:max-w-3xl shadow-xl h-full md:h-auto flex flex-col pt-safe md:pt-0"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
		role="dialog"
		tabindex="-1"
	>
		<!-- Universal search bar with inline pills -->
		<div class="p-3 border-b border-[var(--color-border)] flex items-center gap-2">
			<button
				onclick={handleClose}
				class="md:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2"
				title="Close search"
			>
				<CaretLeft size={20} />
			</button>
			<MagnifyingGlass size={16} class="text-[var(--color-text-muted)] shrink-0" />
			<div
				class="flex-1 flex items-center gap-1.5 flex-wrap min-w-0"
				onclick={() => searchInput?.focus()}
				onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') searchInput?.focus(); }}
				role="button"
				tabindex="0"
			>
				{#each pills as pill, i (pill.raw + i)}
					<span class="inline-flex items-center gap-1 text-xs bg-[var(--color-accent)]/15 text-[var(--color-accent)] border border-[var(--color-accent)]/30 rounded-md px-1.5 py-0.5 shrink-0 search-pill" data-testid="search-pill">
						<span class="text-[var(--color-text-muted)] text-[10px]">{pill.key}:</span>
						<span>{pillLabel(pill)}</span>
						<button
							type="button"
							onclick={(e) => { e.stopPropagation(); removePill(i); }}
							class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] -mr-0.5 min-w-[32px] min-h-[32px] md:min-w-0 md:min-h-0 flex items-center justify-center"
							aria-label="Remove {pill.key} filter"
						>
							<X size={12} />
						</button>
					</span>
				{/each}
				<input
					bind:this={searchInput}
					type="text"
					bind:value={query}
					oninput={handleInput}
					onkeydown={handleKeydown}
					placeholder={pills.length > 0 ? 'Add more filters or search...' : 'Search messages... try in: from: before: after: has:'}
					class="flex-1 min-w-[120px] bg-transparent text-sm focus:outline-none placeholder:text-[var(--color-text-muted)]"
					data-testid="search-input"
				/>
			</div>
			<kbd class="hidden md:inline-flex text-[10px] text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-1.5 py-0.5 shrink-0">ESC</kbd>
		</div>

		<!-- Autocomplete dropdown -->
		{#if acOpen}
			<div class="relative">
				<div class="ac-dropdown dark-scrollbar absolute left-0 right-0 top-0 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] shadow-lg z-20 max-h-48 md:max-h-64 overflow-y-auto" data-testid="ac-dropdown">
					<div class="px-3 pt-2 pb-1">
						<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
							{acOperator === 'in' ? 'Channels' : acOperator === 'from' ? 'People' : acOperator === 'before' || acOperator === 'after' ? 'Date' : 'Filter'}
						</span>
					</div>
					{#each acItems as item, i (item.value)}
						<button
							type="button"
							onmousedown={(e) => { e.preventDefault(); selectAutocompleteItem(item); }}
							ontouchend={(e) => { e.preventDefault(); selectAutocompleteItem(item); }}
							onmouseenter={() => (acSelectedIndex = i)}
							class="w-full text-left px-3 py-1.5 md:py-1.5 min-h-[44px] md:min-h-0 text-sm flex items-center gap-2 transition-colors {acSelectedIndex === i ? 'bg-[var(--color-bg-selected)]' : ''}"
							data-testid="ac-item"
						>
							<span class="truncate">{item.label}</span>
							{#if item.detail}
								<span class="text-xs text-[var(--color-text-muted)] ml-auto truncate">{item.detail}</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		{#snippet messagesSection()}
			{#if query.trim() || pills.length > 0}
				{#if messageLoading}
					<div class="px-3 pt-3 pb-1">
						<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Messages</span>
					</div>
					<div class="px-3 py-2 text-sm text-[var(--color-text-muted)]">Searching...</div>
				{:else if messageSearched && messageResults.length === 0}
					<div class="px-3 pt-3 pb-1">
						<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Messages</span>
					</div>
					<div class="px-3 py-2 text-sm text-[var(--color-text-muted)]">No messages found</div>
				{:else if messageResults.length > 0}
					<div class="px-3 pt-3 pb-1 flex items-baseline justify-between gap-2">
						<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Messages</span>
						<div class="flex items-center gap-2">
							<span class="text-[10px] text-[var(--color-text-muted)]">
								{messageResults.length} of {messageTotal}
							</span>
							<button
								type="button"
								onclick={() => handleToggleSaved(undefined, getFullQuery())}
								title={currentQuerySaved ? 'Unsave this search' : 'Save this search'}
								class="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors p-0.5"
								aria-label={currentQuerySaved ? 'Unsave search' : 'Save search'}
							>
								<Star size={12} weight={currentQuerySaved ? 'fill' : 'regular'} class={currentQuerySaved ? 'text-[var(--color-accent)]' : ''} />
							</button>
						</div>
					</div>
					{#each messageResults as msg, i (msg.id)}
						{@const idx = itemIndex(sectionOffset('messages'), i)}
						{@const dmName = dmNameById.get(msg.channel_id)}
						<button
							data-search-index={idx}
							onclick={() => selectItem(msg)}
							onmouseenter={() => (selectedIndex = idx)}
							class="w-full text-left px-3 py-2 min-h-[44px] md:min-h-0 transition-colors {selectedIndex === idx ? 'bg-[var(--color-bg-selected)]' : ''}"
						>
							<div class="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mb-0.5">
								<span class="text-[var(--color-accent)]">{dmName ? `@${dmName}` : `#${msg.channel_name}`}</span>
								<span>{msg.display_name || msg.username}</span>
								<span>{formatTime(msg.created_at)}</span>
							</div>
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							<p class="text-sm truncate search-snippet">{@html renderSnippet(msg.snippet, msg.content)}</p>
						</button>
					{/each}
					{#if messageHasMore}
						<button
							onclick={loadMoreMessages}
							disabled={messageLoadingMore}
							class="w-full text-center px-3 py-2 min-h-[44px] md:min-h-0 text-xs text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
						>
							{messageLoadingMore ? 'Loading…' : `Load more (${messageTotal - messageResults.length} remaining)`}
						</button>
					{/if}
				{/if}
			{/if}
		{/snippet}

		<div class="flex-1 md:max-h-[36rem] overflow-y-auto dark-scrollbar">
			{#if hasActiveFilter}
				{@render messagesSection()}
			{/if}

			{#if historyItems.length > 0}
				{@const savedCount = historyItems.filter((h) => h.source === 'saved').length}
				{@const recentCount = historyItems.length - savedCount}
				{#if savedCount > 0}
					<div class="px-3 pt-2 pb-1">
						<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Saved searches</span>
					</div>
					{#each historyItems.filter((h) => h.source === 'saved') as h, i (h.id)}
						{@const idx = itemIndex(sectionOffset('saved'), i)}
						<div
							class="group flex items-center transition-colors {selectedIndex === idx ? 'bg-[var(--color-bg-selected)]' : ''}"
							onmouseenter={() => (selectedIndex = idx)}
						>
							<button
								data-search-index={idx}
								onclick={() => selectItem(h)}
								class="flex-1 min-w-0 text-left px-3 py-2 min-h-[44px] md:min-h-0 flex items-center gap-2"
							>
								<span class="text-[var(--color-accent)] shrink-0 w-5 flex items-center justify-center">
									<Star size={14} weight="fill" />
								</span>
								<span class="text-sm truncate">{formatHistoryQuery(h.query)}</span>
							</button>
							<button
								type="button"
								onclick={(e) => handleToggleSaved(e, h.query)}
								title="Unsave"
								class="md:opacity-0 md:group-hover:opacity-100 transition-opacity text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center"
								aria-label="Unsave search"
							>
								<X size={12} />
							</button>
						</div>
					{/each}
				{/if}
				{#if recentCount > 0}
					<div class="px-3 pt-2 pb-1 flex items-baseline justify-between">
						<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Recent searches</span>
					</div>
					{#each historyItems.filter((h) => h.source === 'recent') as h, i (h.id)}
						{@const idx = itemIndex(sectionOffset('recent'), i)}
						<div
							class="group flex items-center transition-colors {selectedIndex === idx ? 'bg-[var(--color-bg-selected)]' : ''}"
							onmouseenter={() => (selectedIndex = idx)}
						>
							<button
								data-search-index={idx}
								onclick={() => selectItem(h)}
								class="flex-1 min-w-0 text-left px-3 py-2 min-h-[44px] md:min-h-0 flex items-center gap-2"
							>
								<span class="text-[var(--color-text-muted)] shrink-0 w-5 flex items-center justify-center">
									<Clock size={14} />
								</span>
								<span class="text-sm truncate">{formatHistoryQuery(h.query)}</span>
							</button>
							<button
								type="button"
								onclick={(e) => handleToggleSaved(e, h.query)}
								title="Save search"
								class="md:opacity-0 md:group-hover:opacity-100 transition-opacity text-[var(--color-text-muted)] hover:text-[var(--color-accent)] px-1 py-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center"
								aria-label="Save search"
							>
								<Star size={12} />
							</button>
							<button
								type="button"
								onclick={(e) => handleRemoveRecent(e, h.query)}
								title="Remove from recent"
								class="md:opacity-0 md:group-hover:opacity-100 transition-opacity text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center"
								aria-label="Remove recent search"
							>
								<X size={12} />
							</button>
						</div>
					{/each}
				{/if}
			{/if}

			{#if filteredPages.length > 0 || filteredChannels.length > 0}
				<div class="px-3 pt-2 pb-1">
					<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
						{query.trim() ? 'Channels & DMs' : 'Jump to...'}
					</span>
				</div>
				{#each filteredPages as page, i (page.id)}
					{@const idx = itemIndex(sectionOffset('pages'), i)}
					<button
						data-search-index={idx}
						onclick={() => selectItem(page)}
						onmouseenter={() => (selectedIndex = idx)}
						class="w-full text-left px-3 py-2 min-h-[44px] md:min-h-0 flex items-center gap-2 transition-colors {selectedIndex === idx ? 'bg-[var(--color-bg-selected)]' : ''}"
					>
						<span class="text-[var(--color-text-muted)] shrink-0 w-5 flex items-center justify-center">
							<Cpu size={14} />
						</span>
						<span class="text-sm truncate">{page.name}</span>
						<span class="ml-auto text-xs text-[var(--color-text-muted)] truncate max-w-[40%]">
							{page.description}
						</span>
					</button>
				{/each}
				{#each filteredChannels as ch, i (ch.id)}
					{@const idx = itemIndex(sectionOffset('channels'), i)}
					<button
						data-search-index={idx}
						onclick={() => selectItem(ch)}
						onmouseenter={() => (selectedIndex = idx)}
						class="w-full text-left px-3 py-2 min-h-[44px] md:min-h-0 flex items-center gap-2 transition-colors {selectedIndex === idx ? 'bg-[var(--color-bg-selected)]' : ''}"
					>
						<span class="text-[var(--color-text-muted)] shrink-0 w-5 flex items-center justify-center">
							{#if ch.is_dm}
								{#if ch.is_bot}
									<Robot size={14} />
								{:else}
									<ChatCircleDots size={14} />
								{/if}
							{:else if ch.is_private}
								<Lock size={14} />
							{:else}
								<Hash size={14} />
							{/if}
						</span>
						<span class="text-sm truncate">
							{ch.is_dm ? ch.dm_partner_name : ch.name}
						</span>
						{#if ch.has_unread && ch.unread_count > 0}
							<span class="ml-auto shrink-0 bg-[var(--color-accent)] text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
								{ch.unread_count}
							</span>
						{/if}
						{#if ch.description && !ch.is_dm}
							<span class="ml-auto text-xs text-[var(--color-text-muted)] truncate max-w-[40%]">
								{ch.description}
							</span>
						{/if}
					</button>
				{/each}
			{/if}

			{#if !hasActiveFilter}
				{@render messagesSection()}
			{/if}

			{#if !query.trim() && pills.length === 0 && filteredPages.length === 0 && filteredChannels.length === 0}
				<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
					No channels yet
				</div>
			{:else if (query.trim() || pills.length > 0) && filteredPages.length === 0 && filteredChannels.length === 0 && messageSearched && messageResults.length === 0}
				<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
					No results for "{getFullQuery()}"
				</div>
			{/if}
		</div>

		<div class="hidden md:flex items-center gap-3 px-3 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
			<span><kbd class="border border-[var(--color-border)] rounded px-1 py-0.5">↑↓</kbd> navigate</span>
			<span><kbd class="border border-[var(--color-border)] rounded px-1 py-0.5">↵</kbd> select</span>
			<span><kbd class="border border-[var(--color-border)] rounded px-1 py-0.5">tab</kbd> complete</span>
			<span><kbd class="border border-[var(--color-border)] rounded px-1 py-0.5">esc</kbd> close</span>
		</div>
	</div>
</div>

<style>
	.search-snippet :global(mark) {
		background-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
		color: inherit;
		padding: 0 1px;
		border-radius: 2px;
	}
.search-pill {
		animation: pill-in 0.15s ease-out;
	}
	@keyframes pill-in {
		from { transform: scale(0.85); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
	/* Mobile: autocomplete as bottom sheet */
	@media (max-width: 767px) {
		.ac-dropdown {
			position: fixed !important;
			bottom: 0 !important;
			top: auto !important;
			left: 0 !important;
			right: 0 !important;
			max-height: 50vh !important;
			border-radius: 12px 12px 0 0;
			border-top: 1px solid var(--color-border);
			padding-bottom: env(safe-area-inset-bottom, 0px);
		}
}
</style>
