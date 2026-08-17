/**
 * Format a unix timestamp (seconds) into a human-readable time string.
 */
export function formatTime(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const isYesterday = date.toDateString() === yesterday.toDateString();

	const time = date.toLocaleTimeString(undefined, {
		hour: 'numeric',
		minute: '2-digit'
	});

	if (isToday) return time;
	if (isYesterday) return `Yesterday at ${time}`;

	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
	}) + ` at ${time}`;
}

/**
 * Format a unix timestamp into a date separator label.
 */
export function formatDateSeparator(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const isYesterday = date.toDateString() === yesterday.toDateString();

	if (isToday) return 'Today';
	if (isYesterday) return 'Yesterday';

	return date.toLocaleDateString(undefined, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
	});
}

/**
 * Get the date key for grouping messages (YYYY-MM-DD).
 */
export function dateKey(timestamp: number): string {
	const d = new Date(timestamp * 1000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
