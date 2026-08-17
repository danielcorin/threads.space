// Code theme selection state for fenced code block syntax highlighting.
// Source of truth is the user profile (`code_theme` on the users row) — when
// NULL we resolve to the default. Non-default selections are PATCHed back to
// the API; reverting to default writes NULL.

import { api } from '$lib/api.js';

export interface CodeThemeOption {
	key: string;
	label: string;
	loadCss: () => Promise<{ default: string }>;
}

export const DEFAULT_CODE_THEME = 'monokai-sublime';

// Registry: theme key -> human label + dynamic CSS import.
// Using `?inline` so Vite returns the CSS as a string we can inject into a
// single <style id="hljs-theme"> tag, avoiding a network roundtrip per
// theme switch and a stack of <link> tags.
export const CODE_THEMES: CodeThemeOption[] = [
	{ key: 'monokai-sublime', label: 'Monokai (Sublime)', loadCss: () => import('highlight.js/styles/monokai-sublime.css?inline') },
	{ key: 'monokai', label: 'Monokai', loadCss: () => import('highlight.js/styles/monokai.css?inline') },
	{ key: 'github-dark', label: 'GitHub Dark', loadCss: () => import('highlight.js/styles/github-dark.css?inline') },
	{ key: 'github', label: 'GitHub Light', loadCss: () => import('highlight.js/styles/github.css?inline') },
	{ key: 'atom-one-dark', label: 'Atom One Dark', loadCss: () => import('highlight.js/styles/atom-one-dark.css?inline') },
	{ key: 'dracula', label: 'Dracula', loadCss: () => import('highlight.js/styles/base16/dracula.css?inline') },
	{ key: 'solarized-dark', label: 'Solarized Dark', loadCss: () => import('highlight.js/styles/base16/solarized-dark.css?inline') },
	{ key: 'solarized-light', label: 'Solarized Light', loadCss: () => import('highlight.js/styles/base16/solarized-light.css?inline') },
	{ key: 'nord', label: 'Nord', loadCss: () => import('highlight.js/styles/nord.css?inline') },
];

export const CODE_THEME_KEYS = CODE_THEMES.map(t => t.key);

export function isValidCodeTheme(key: unknown): key is string {
	return typeof key === 'string' && CODE_THEME_KEYS.includes(key);
}

let _theme = $state<string>(DEFAULT_CODE_THEME);

/**
 * Inject the active theme's CSS as a single <style id="hljs-theme"> tag,
 * replacing any prior one. One DOM swap per change.
 */
async function applyCodeTheme(themeKey: string): Promise<void> {
	if (typeof document === 'undefined') return;
	const opt = CODE_THEMES.find(t => t.key === themeKey);
	if (!opt) return;
	try {
		const mod = await opt.loadCss();
		const css = mod.default;
		let tag = document.getElementById('hljs-theme') as HTMLStyleElement | null;
		if (!tag) {
			tag = document.createElement('style');
			tag.id = 'hljs-theme';
			document.head.appendChild(tag);
		}
		tag.textContent = css;
	} catch (err) {
		console.error('[codeTheme] failed to load theme', themeKey, err);
	}
}

export const codeTheme = {
	/** Active theme key (resolved — NULL profile field becomes the default). */
	get value(): string {
		return _theme;
	},
	/** CSS class form used by the markdown renderer (`theme-{key}`). */
	get className(): string {
		return `theme-${_theme}`;
	},
	/**
	 * Hydrate from a loaded user profile. NULL/missing -> default.
	 * Applies the theme CSS as a side-effect.
	 */
	hydrate(profileValue: string | null | undefined): void {
		const key = isValidCodeTheme(profileValue) ? profileValue : DEFAULT_CODE_THEME;
		_theme = key;
		void applyCodeTheme(key);
	},
	/**
	 * Set a new theme. Updates local state immediately, applies the CSS,
	 * and PATCHes the profile (NULL when reverting to default).
	 */
	async set(themeKey: string): Promise<void> {
		if (!isValidCodeTheme(themeKey)) return;
		_theme = themeKey;
		void applyCodeTheme(themeKey);
		const persisted = themeKey === DEFAULT_CODE_THEME ? null : themeKey;
		try {
			await api.users.updateProfile({ codeTheme: persisted });
		} catch (err) {
			console.error('[codeTheme] failed to persist', err);
		}
	},
};
