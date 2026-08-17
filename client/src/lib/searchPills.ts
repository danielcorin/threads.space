// Pure pill/filter logic extracted from SearchPanel.svelte so it can be
// unit-tested without the component (companion to searchSyntax.ts /
// searchHistory.ts).

export interface Pill {
	key: string;
	value: string;
	raw: string;
	displayValue?: string;
}

export interface NamedChannel {
	id: string;
	name: string;
}

export interface DmPartnerEntry {
	id: string;
	partner: { id: string; username: string; display_name: string | null };
}

/** Map pill operators to API filter keys. */
export const OPERATOR_MAP: Record<string, string> = {
	in: 'channel',
	from: 'from',
	before: 'until',
	after: 'since',
	has: 'has'
};

export const SEARCH_OPERATORS = ['in', 'from', 'before', 'after', 'has'];

/** Build effective filters from pills for API calls. */
export function pillFilters(pills: Pill[]): Record<string, string> {
	const f: Record<string, string> = {};
	for (const p of pills) {
		const key = OPERATOR_MAP[p.key] || p.key;
		f[key] = p.value;
	}
	return f;
}

/**
 * Resolve a date filter value ('yesterday', '7d', ISO date) to an epoch-seconds
 * string; anything unrecognized passes through. `now` is injectable for tests.
 */
export function resolveDate(value: string, now: Date = new Date()): string {
	if (value === 'yesterday') {
		const d = new Date(now);
		d.setDate(d.getDate() - 1);
		return String(Math.floor(d.getTime() / 1000));
	}
	const match = value.match(/^(\d+)d$/);
	if (match) {
		const days = parseInt(match[1], 10);
		const d = new Date(now);
		d.setDate(d.getDate() - days);
		return String(Math.floor(d.getTime() / 1000));
	}
	// ISO date
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return String(Math.floor(new Date(value + 'T00:00:00').getTime() / 1000));
	}
	return value;
}

/** Last space-separated token of the query, when it's a known operator. */
export function getCurrentToken(query: string): { prefix: string; value: string } | null {
	const parts = query.split(/\s+/);
	const last = parts[parts.length - 1];
	if (!last) return null;
	const colonIdx = last.indexOf(':');
	if (colonIdx > 0) {
		const prefix = last.slice(0, colonIdx).toLowerCase();
		const value = last.slice(colonIdx + 1);
		if (SEARCH_OPERATORS.includes(prefix)) {
			return { prefix, value };
		}
	}
	return null;
}

/** Resolve a channel/DM display name to an id for the API (falls through to the name). */
export function resolveChannelId(name: string, channelList: NamedChannel[], dmList: DmPartnerEntry[]): string {
	const ch = channelList.find((c) => c.name.toLowerCase() === name.toLowerCase());
	if (ch) return ch.id;
	const dm = dmList.find((d) => {
		const partner = d.partner.display_name || d.partner.username;
		return partner.toLowerCase() === name.toLowerCase();
	});
	return dm?.id || name;
}

/** Human-readable pill label, resolving channel/user ids against current state. */
export function pillLabel(p: Pill, channelList: NamedChannel[], dmList: DmPartnerEntry[]): string {
	if (p.key === 'in') {
		const ch = channelList.find((c) => c.id === p.value || c.name === p.value);
		if (ch) return `#${ch.name}`;
		const dm = dmList.find((d) => d.id === p.value);
		if (dm) return `@${dm.partner.display_name || dm.partner.username}`;
		return p.displayValue || p.value;
	}
	if (p.key === 'from') {
		if (p.displayValue) return `@${p.displayValue}`;
		const dm = dmList.find((d) => d.partner.id === p.value);
		if (dm) return `@${dm.partner.display_name || dm.partner.username}`;
		return `@${p.value}`;
	}
	return p.displayValue || p.value;
}

/**
 * Resolve any unresolved in:ID / from:ID fragments in a stored history query
 * against current channel/user state.
 */
export function resolveHistoryQueryIds(base: string, channelList: NamedChannel[], dmList: DmPartnerEntry[]): string {
	return base.replace(/\b(in|from):(\S+)/g, (match, key, val) => {
		if (key === 'in') {
			const ch = channelList.find((c) => c.id === val);
			if (ch) return `in:${ch.name}`;
		} else if (key === 'from') {
			const dm = dmList.find((d) => d.partner.id === val);
			if (dm) return `from:${dm.partner.display_name || dm.partner.username}`;
		}
		return match;
	});
}
