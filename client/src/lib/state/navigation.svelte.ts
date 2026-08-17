import type { AppView } from './ui.svelte.js';

const MAX_HISTORY = 100;

export interface NavEntry {
	view: AppView;
	channelId: string | null;
	dmId: string | null;
	threadMessageId: string | null;
}

function entriesEqual(a: NavEntry, b: NavEntry): boolean {
	return a.view === b.view && a.channelId === b.channelId && a.dmId === b.dmId && a.threadMessageId === b.threadMessageId;
}

let _history = $state<NavEntry[]>([]);
let _index = $state(-1);
let _navigating = $state(false);

export const navigation = {
	get canGoBack() {
		return _index > 0;
	},
	get canGoForward() {
		return _index < _history.length - 1;
	},
	get navigating() {
		return _navigating;
	},
	set navigating(v: boolean) {
		_navigating = v;
	},

	push(entry: NavEntry) {
		if (_navigating) return;

		// Deduplicate: don't push if it matches the current entry
		if (_index >= 0 && _index < _history.length && entriesEqual(_history[_index], entry)) {
			return;
		}

		// Truncate forward history
		_history = _history.slice(0, _index + 1);

		_history.push(entry);

		// Cap at max size, dropping oldest entries
		if (_history.length > MAX_HISTORY) {
			const excess = _history.length - MAX_HISTORY;
			_history = _history.slice(excess);
		}

		_index = _history.length - 1;
	},

	back(): NavEntry | null {
		if (_index <= 0) return null;
		_index--;
		return _history[_index];
	},

	forward(): NavEntry | null {
		if (_index >= _history.length - 1) return null;
		_index++;
		return _history[_index];
	},

	reset() {
		_history = [];
		_index = -1;
		_navigating = false;
	}
};
