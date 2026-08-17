import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SearchPanel from './SearchPanel.svelte';

// Mock api module
vi.mock('$lib/api.js', () => ({
	api: {
		channels: { list: vi.fn().mockResolvedValue([]) },
		users: { search: vi.fn().mockResolvedValue([]) },
		search: vi.fn().mockResolvedValue({ results: [], total: 0, hasMore: false, offset: 0, limit: 50 }),
		dms: { list: vi.fn().mockResolvedValue([]) },
	}
}));

// Mock state modules
vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: {
		list: [
			{ id: 'ch1', name: 'general', description: 'General chat', is_private: 0, has_unread: 0, unread_count: 0 },
			{ id: 'ch2', name: 'random', description: 'Random stuff', is_private: 0, has_unread: 0, unread_count: 0 },
		],
		select: vi.fn(),
	}
}));

vi.mock('$lib/state/dms.svelte.js', () => ({
	dms: {
		list: [],
		select: vi.fn(),
	}
}));

vi.mock('$lib/state/ui.svelte.js', () => ({
	ui: { setView: vi.fn() }
}));

// Mutable state for searchHistory mock — tests can override before rendering
let mockRecentSearches: string[] = [];
let mockDisplayMap: Record<string, string> = {};
let mockLastQuery: { query: string; pills: Array<{ key: string; value: string; raw: string; displayValue?: string }> } | null = null;

vi.mock('$lib/searchHistory.js', () => ({
	getRecentSearches: () => mockRecentSearches,
	addRecentSearch: vi.fn(),
	removeRecentSearch: vi.fn(),
	getSavedSearches: () => [],
	isSaved: () => false,
	toggleSavedSearch: vi.fn(),
	setDisplayQuery: vi.fn((raw: string, display: string) => { mockDisplayMap[raw] = display; }),
	getDisplayQuery: vi.fn((raw: string) => mockDisplayMap[raw] || raw),
	getLastQuery: vi.fn(() => mockLastQuery),
	setLastQuery: vi.fn((data: any) => { mockLastQuery = data; }),
}));

describe('SearchPanel', () => {
	const onclose = vi.fn();
	const onnavigatetomessage = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockRecentSearches = [];
		mockDisplayMap = {};
		mockLastQuery = null;
	});

	it('renders search input', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await expect.element(input).toBeVisible();
	});

	it('typing in: opens channel autocomplete dropdown', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('in:g');

		// Should show the autocomplete dropdown with channel results
		const dropdown = page.getByTestId('ac-dropdown');
		await expect.element(dropdown).toBeVisible();

		// Should contain #general since it matches 'g'
		const items = page.getByTestId('ac-item');
		const firstItem = items.first();
		await expect.element(firstItem).toBeVisible();
	});

	it('selecting autocomplete item creates a pill', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('in:g');

		// Click the first autocomplete item
		const items = page.getByTestId('ac-item');
		await items.first().click();

		// Should create a pill
		const pill = page.getByTestId('search-pill');
		await expect.element(pill).toBeVisible();

		// Autocomplete should close
		await expect.element(page.getByTestId('ac-dropdown')).not.toBeInTheDocument();
	});

	it('backspace removes last pill when input is empty', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');

		// Create a pill first
		await input.fill('in:g');
		const items = page.getByTestId('ac-item');
		await items.first().click();

		// Verify pill exists
		await expect.element(page.getByTestId('search-pill')).toBeVisible();

		// Now the input should be empty; press backspace via keyboard event
		const el = input.element() as HTMLInputElement;
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

		// Pill should be removed
		await expect.element(page.getByTestId('search-pill')).not.toBeInTheDocument();
	});

	it('typing bare "in:" (no further chars) opens autocomplete with channel suggestions', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('in:');

		// Should show the autocomplete dropdown with all channels
		const dropdown = page.getByTestId('ac-dropdown');
		await expect.element(dropdown).toBeVisible();

		// Should show at least one channel suggestion
		const items = page.getByTestId('ac-item');
		await expect.element(items.first()).toBeVisible();
		// Both mocked channels should appear
		await expect.element(items.nth(0)).toHaveTextContent(/#general/);
		await expect.element(items.nth(1)).toHaveTextContent(/#random/);
	});

	it('typing bare "from:" opens autocomplete (fires API call)', async () => {
		const { api } = await import('$lib/api.js');
		(api.users.search as any).mockResolvedValueOnce([
			{ id: 'u1', username: 'alice', display_name: 'Alice' },
		]);

		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('from:');

		// Wait for the debounced API call (0ms for empty val)
		await new Promise((r) => setTimeout(r, 100));

		// The users.search should have been called with empty string
		expect(api.users.search).toHaveBeenCalledWith('');

		const dropdown = page.getByTestId('ac-dropdown');
		await expect.element(dropdown).toBeVisible();
	});

	it('typing bare "before:" opens autocomplete with date presets', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('before:');

		const dropdown = page.getByTestId('ac-dropdown');
		await expect.element(dropdown).toBeVisible();

		const items = page.getByTestId('ac-item');
		await expect.element(items.first()).toHaveTextContent(/Yesterday/);
	});

	it('typing bare "after:" opens autocomplete with date presets', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('after:');

		const dropdown = page.getByTestId('ac-dropdown');
		await expect.element(dropdown).toBeVisible();

		const items = page.getByTestId('ac-item');
		await expect.element(items.first()).toHaveTextContent(/Yesterday/);
	});

	it('has: shows static options in autocomplete', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await input.fill('has:');

		const dropdown = page.getByTestId('ac-dropdown');
		await expect.element(dropdown).toBeVisible();

		// Should show link, reaction, file options
		const items = page.getByTestId('ac-item');
		await expect.element(items.nth(0)).toHaveTextContent(/link/);
		await expect.element(items.nth(1)).toHaveTextContent(/reaction/);
		await expect.element(items.nth(2)).toHaveTextContent(/file/);
	});

	it('selecting a channel result fires onchannelselect so the composer re-focuses', async () => {
		const onchannelselect = vi.fn();
		const { channels } = await import('$lib/state/channels.svelte.js');
		render(SearchPanel, { onclose, onnavigatetomessage, onchannelselect });

		// "Jump to..." channel list shows on mount (empty query). Click #general.
		const general = page.getByText('general', { exact: true });
		await general.click();

		expect(channels.select).toHaveBeenCalledWith('ch1');
		expect(onchannelselect).toHaveBeenCalled();
		expect(onclose).toHaveBeenCalled();
	});

	it('escape closes the panel', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		const el = input.element() as HTMLInputElement;
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onclose).toHaveBeenCalled();
	});

	it('no duplicate pill chip row when pills are active', async () => {
		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');

		// Create a pill via autocomplete
		await input.fill('in:g');
		const items = page.getByTestId('ac-item');
		await items.first().click();

		// The inline pill should exist
		const inlinePills = page.getByTestId('search-pill');
		await expect.element(inlinePills.first()).toBeVisible();

		// There should be no separate "pill summary" row with rounded-full chips
		// (the old duplicate row used rounded-full pills outside the input bar)
		const summaryChips = document.querySelectorAll('.rounded-full');
		// Filter to only those that contain pill key text like "in:" — none should exist
		const duplicateChips = Array.from(summaryChips).filter((el) =>
			el.textContent?.includes('in:') && el.closest('[class*="border-b"]') !== null
		);
		expect(duplicateChips.length).toBe(0);
	});

	it('history entries display names not raw ids when resolvable', async () => {
		// Set up mock: recent search with a raw channel ID, display map has friendly version
		mockRecentSearches = ['in:ch1 hello'];
		mockDisplayMap = { 'in:ch1 hello': 'in:general hello' };

		render(SearchPanel, { onclose, onnavigatetomessage });

		// History items should be visible (input is empty on mount)
		// The recent search text should show the display version
		const recentItem = page.getByText('in:general hello');
		await expect.element(recentItem).toBeVisible();
	});

	it('panel re-mount restores last query from localStorage', async () => {
		const { getLastQuery: _getLastQuery } = await import('$lib/searchHistory.js');

		// Set up persisted query before render
		mockLastQuery = {
			query: 'test search',
			pills: [{ key: 'in', value: 'ch1', raw: 'in:ch1' }],
		};

		render(SearchPanel, { onclose, onnavigatetomessage });

		// Input should contain the persisted free text
		const input = page.getByTestId('search-input');
		await expect.element(input).toHaveValue('test search');

		// Pill should be restored
		const pill = page.getByTestId('search-pill');
		await expect.element(pill).toBeVisible();
	});

	it('first Backspace after restoring a previous search clears query and pills', async () => {
		const { setLastQuery } = await import('$lib/searchHistory.js');

		mockLastQuery = {
			query: 'test search',
			pills: [{ key: 'in', value: 'ch1', raw: 'in:ch1' }],
		};

		render(SearchPanel, { onclose, onnavigatetomessage });
		const input = page.getByTestId('search-input');
		await expect.element(input).toHaveValue('test search');
		await expect.element(page.getByTestId('search-pill')).toBeVisible();

		const el = input.element() as HTMLInputElement;
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

		await expect.element(input).toHaveValue('');
		await expect.element(page.getByTestId('search-pill')).not.toBeInTheDocument();
		expect(setLastQuery).toHaveBeenCalledWith({ query: '', pills: [] });
	});

	describe('mobile touch targets', () => {
		it('pill remove button has mobile touch target classes', async () => {
			render(SearchPanel, { onclose, onnavigatetomessage });
			const input = page.getByTestId('search-input');
			await input.fill('in:g');
			const items = page.getByTestId('ac-item');
			await items.first().click();

			// Pill should exist
			const pill = page.getByTestId('search-pill');
			await expect.element(pill).toBeVisible();

			// Find the remove button inside the pill
			const removeBtn = pill.element()!.querySelector('button[aria-label^="Remove"]') as HTMLElement;
			expect(removeBtn).toBeTruthy();

			// min-w-[32px] min-h-[32px] provides touch target on mobile (reset by md: on desktop)
			expect(removeBtn.className).toContain('min-w-[32px]');
			expect(removeBtn.className).toContain('min-h-[32px]');
		});

		it('autocomplete items have mobile touch target class', async () => {
			render(SearchPanel, { onclose, onnavigatetomessage });
			const input = page.getByTestId('search-input');
			await input.fill('in:');

			const item = page.getByTestId('ac-item').first();
			await expect.element(item).toBeVisible();

			const el = item.element() as HTMLElement;
			// min-h-[44px] provides 44px touch target on mobile (reset by md:min-h-0 on desktop)
			expect(el.className).toContain('min-h-[44px]');
		});

		it('close button flushes query persistence', async () => {
			const { setLastQuery } = await import('$lib/searchHistory.js');

			render(SearchPanel, { onclose, onnavigatetomessage });
			const input = page.getByTestId('search-input');
			await input.fill('hello world');

			// Click the mobile close button (CaretLeft)
			const closeBtn = document.querySelector('button[title="Close search"]') as HTMLElement;
			expect(closeBtn).toBeTruthy();
			closeBtn.click();

			// setLastQuery should be called synchronously on close
			expect(setLastQuery).toHaveBeenCalledWith(
				expect.objectContaining({ query: 'hello world' })
			);
			expect(onclose).toHaveBeenCalled();
		});

		it('history action buttons are visible on mobile (not hidden behind hover)', async () => {
			mockRecentSearches = ['test query'];
			render(SearchPanel, { onclose, onnavigatetomessage });

			// The remove button for a recent search should not have opacity-0 without md: prefix
			const removeBtn = document.querySelector('button[aria-label="Remove recent search"]') as HTMLElement;
			expect(removeBtn).toBeTruthy();
			// On mobile, the button should not have opacity:0 — the class uses md:opacity-0
			const classes = removeBtn.className;
			expect(classes).toContain('md:opacity-0');
			expect(classes).not.toMatch(/(?<!\bmd:)opacity-0/);
		});
	});

	describe('results-first ordering when filters active', () => {
		it('Messages heading appears before Channels & DMs heading when a pill filter is set', async () => {
			const { api } = await import('$lib/api.js');
			(api.search as any).mockResolvedValueOnce({
				results: [
					{ id: 'm1', channel_id: 'ch1', content: 'hello world', snippet: 'hello world', username: 'alice', display_name: 'Alice', channel_name: 'general', created_at: 1700000000 },
				],
				total: 1,
				hasMore: false,
				offset: 0,
				limit: 50,
			});

			render(SearchPanel, { onclose, onnavigatetomessage });
			const input = page.getByTestId('search-input');

			// Create a pill via autocomplete
			await input.fill('in:g');
			const acItems = page.getByTestId('ac-item');
			await acItems.first().click();

			// Wait for search debounce + API response
			await new Promise((r) => setTimeout(r, 400));

			// Both headings should exist
			const allHeadings = document.querySelectorAll('span.text-\\[10px\\]');
			const headingTexts = Array.from(allHeadings).map((el) => el.textContent?.trim());
			const messagesIdx = headingTexts.indexOf('Messages');
			const channelsIdx = headingTexts.findIndex((t) => t === 'Channels & DMs' || t === 'Jump to...');

			expect(messagesIdx).toBeGreaterThanOrEqual(0);
			expect(channelsIdx).toBeGreaterThanOrEqual(0);
			expect(messagesIdx).toBeLessThan(channelsIdx);
		});
	});

	describe('selected-row highlight', () => {
		it('keyboard-highlighted row uses bg-[var(--color-bg-selected)] not bg-[var(--color-bg-hover)]', async () => {
			render(SearchPanel, { onclose, onnavigatetomessage });

			// The first channel row should be selected by default (selectedIndex=0)
			// Find all buttons with data-search-index attribute
			const rows = document.querySelectorAll('[data-search-index]');
			expect(rows.length).toBeGreaterThan(0);

			const firstRow = rows[0].closest('[class*="bg-"]') || rows[0];
			const classes = firstRow.className;

			// Should use selected color, not hover color
			expect(classes).toContain('bg-[var(--color-bg-selected)]');
			expect(classes).not.toContain('bg-[var(--color-bg-hover)]');
		});
	});
});
