// Central registry for the app's mutually-exclusive dialog modals.
//
// These are the full-screen overlay dialogs (create channel, browse, new DM,
// user settings, search, channel settings, members, agent onboarding). Only one
// may be open at a time: opening any modal closes whichever was previously open,
// and Escape / backdrop clicks route through here so dismissal is uniform.
//
// Deliberately NOT part of this set:
//   - ConfirmDialog — a nested confirmation that must be able to sit *over* the
//     modal that spawned it (e.g. "revoke token?" inside User Settings).
//   - FileViewer / ImageLightbox — content lightboxes opened from a message.
//   - ui panels (board/pins/drafts/debug/widgets) — side panels, already
//     mutually exclusive within ui.svelte.ts.
export type ModalId =
	| 'create-channel'
	| 'browse-channels'
	| 'new-dm'
	| 'user-settings'
	| 'search'
	| 'channel-settings'
	| 'members'
	| 'agent-onboarding';

let _active = $state<ModalId | null>(null);

export const modals = {
	/** The currently open modal, or null when none is open. */
	get active(): ModalId | null {
		return _active;
	},
	/** True when any mutually-exclusive dialog modal is open. */
	get anyOpen() {
		return _active !== null;
	},
	isOpen(id: ModalId) {
		return _active === id;
	},
	/** Open a modal, replacing (closing) whichever was open before. */
	open(id: ModalId) {
		_active = id;
	},
	/** Toggle a modal: open it if closed, close it if it's the active one. */
	toggle(id: ModalId) {
		_active = _active === id ? null : id;
	},
	/**
	 * Close a modal. With an id, closes only if that modal is the active one
	 * (so it never clobbers a different modal). With no id, closes whatever is
	 * open. Returns true if something was actually closed.
	 */
	close(id?: ModalId) {
		if (_active === null) return false;
		if (id != null && _active !== id) return false;
		_active = null;
		return true;
	}
};
