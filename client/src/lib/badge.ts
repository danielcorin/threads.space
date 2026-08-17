import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';

/** Sum all channels' and DMs' unread_count and set the app badge. No-op if Badge API is unavailable. */
export function updateBadge(totalOverride?: number): void {
	if (!('setAppBadge' in navigator)) return;
	const total = totalOverride ?? (
		channels.list.reduce((sum, ch) => sum + (ch.unread_count || 0), 0) +
		dms.list.reduce((sum, dm) => sum + (dm.unread_count || 0), 0)
	);
	if (total > 0) {
		navigator.setAppBadge(total).catch(() => {});
	} else {
		clearBadge();
	}
}

/** Clear the app badge. No-op if Badge API is unavailable. */
export function clearBadge(): void {
	if (!('clearAppBadge' in navigator)) return;
	navigator.clearAppBadge().catch(() => {});
}

/**
 * Request notification permission (required for badges on iOS PWAs).
 * Returns true if permission was granted.
 */
export async function requestNotificationPermission(): Promise<boolean> {
	if (!('Notification' in window)) return false;
	if (Notification.permission === 'granted') return true;
	if (Notification.permission === 'denied') return false;
	const result = await Notification.requestPermission();
	return result === 'granted';
}
