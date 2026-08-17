// Per-device recent + saved search history, persisted in localStorage.
// Recent: capped LRU auto-populated from submitted queries.
// Saved: user-pinned queries (explicit star).
//
// Kept client-only by design — cross-device sync would need a server-backed
// `user_search_history` table; deferred until cross-device becomes a real ask.

const RECENT_KEY = 'threads.search.recent';
const SAVED_KEY = 'threads.search.saved';
const RECENT_MAX = 8;

function readList(key: string): string[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
	} catch {
		return [];
	}
}

function writeList(key: string, items: string[]): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(items));
	} catch {
		// Quota / private-mode — silently drop rather than block search.
	}
}

function normalize(q: string): string {
	return q.trim();
}

export function getRecentSearches(): string[] {
	return readList(RECENT_KEY);
}

export function addRecentSearch(q: string): void {
	const query = normalize(q);
	if (!query) return;
	const current = readList(RECENT_KEY).filter((x) => x !== query);
	current.unshift(query);
	if (current.length > RECENT_MAX) current.length = RECENT_MAX;
	writeList(RECENT_KEY, current);
}

export function removeRecentSearch(q: string): void {
	const query = normalize(q);
	const current = readList(RECENT_KEY).filter((x) => x !== query);
	writeList(RECENT_KEY, current);
}

export function clearRecentSearches(): void {
	writeList(RECENT_KEY, []);
}

export function getSavedSearches(): string[] {
	return readList(SAVED_KEY);
}

export function isSaved(q: string): boolean {
	const query = normalize(q);
	if (!query) return false;
	return readList(SAVED_KEY).includes(query);
}

export function saveSearch(q: string): void {
	const query = normalize(q);
	if (!query) return;
	const current = readList(SAVED_KEY).filter((x) => x !== query);
	current.unshift(query);
	writeList(SAVED_KEY, current);
}

export function unsaveSearch(q: string): void {
	const query = normalize(q);
	const current = readList(SAVED_KEY).filter((x) => x !== query);
	writeList(SAVED_KEY, current);
}

export function toggleSavedSearch(q: string): boolean {
	if (isSaved(q)) {
		unsaveSearch(q);
		return false;
	}
	saveSearch(q);
	return true;
}

// --- Display map: raw query → human-readable version ---
const DISPLAY_MAP_KEY = 'threads.search.displayMap';

function readDisplayMap(): Record<string, string> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(DISPLAY_MAP_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

export function setDisplayQuery(raw: string, display: string): void {
	if (typeof localStorage === 'undefined') return;
	let map = readDisplayMap();
	map[normalize(raw)] = display;
	// Prune entries no longer referenced by recent or saved searches so the
	// map doesn't grow forever.
	const referenced = new Set([...readList(RECENT_KEY), ...readList(SAVED_KEY), normalize(raw)]);
	map = Object.fromEntries(Object.entries(map).filter(([k]) => referenced.has(k)));
	try {
		localStorage.setItem(DISPLAY_MAP_KEY, JSON.stringify(map));
	} catch {
		// quota
	}
}

export function getDisplayQuery(raw: string): string {
	const key = normalize(raw);
	return readDisplayMap()[key] || key;
}

// --- Last query persistence (survives panel close/reopen) ---
const LAST_QUERY_KEY = 'threads.search.lastQuery';

export interface PersistedQuery {
	query: string;
	pills: Array<{ key: string; value: string; raw: string; displayValue?: string }>;
}

export function getLastQuery(): PersistedQuery | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(LAST_QUERY_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		return parsed as PersistedQuery;
	} catch {
		return null;
	}
}

export function setLastQuery(data: PersistedQuery): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(LAST_QUERY_KEY, JSON.stringify(data));
	} catch {
		// quota
	}
}
