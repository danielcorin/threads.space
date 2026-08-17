/**
 * Blur the currently-focused element if it's a text input surface
 * (input, textarea, or contenteditable). No-op on buttons, links, body, etc.
 *
 * Purpose: dismiss the virtual keyboard on mobile when the user triggers
 * a navigation gesture (sidebar swipe) or taps a top-bar control.
 */
export function blurActiveInput() {
	if (typeof document === 'undefined') return;
	const ae = document.activeElement as HTMLElement | null;
	if (!ae) return;
	const tag = ae.tagName;
	const isText =
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		ae.isContentEditable === true ||
		ae.hasAttribute('contenteditable');
	if (isText) ae.blur();
}
