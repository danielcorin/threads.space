// Web Share Target: the installed PWA appears in the OS share sheet (Android,
// ChromeOS). The manifest posts shares to /share-target; sw.js stashes any
// files in Cache Storage and redirects to `/?share-target=1&title=…&text=…&url=…`.
// The page reads the text from the URL and takes the files from the cache.

export const SHARE_TARGET_PARAM = 'share-target';
export const SHARE_TARGET_CACHE = 'threads-share-target';

export type ShareDestination = { kind: 'channel' | 'dm'; id: string };

export interface SharedPayload {
	text: string;
	files: File[];
}

/**
 * Combine the share fields into one message body. Apps often repeat the URL
 * inside `text`, or send a `title` that `text` already contains, so skip
 * fields that would only duplicate another.
 */
export function sharedMessageText(params: URLSearchParams): string {
	const title = params.get('title')?.trim() ?? '';
	const text = params.get('text')?.trim() ?? '';
	const url = params.get('url')?.trim() ?? '';

	const parts: string[] = [];
	if (title && title !== url && !text.includes(title)) parts.push(title);
	if (text) parts.push(text);
	if (url && !text.includes(url)) parts.push(url);
	return parts.join('\n');
}

/** Read the files sw.js stored for the current share, then clear them. */
export async function takeSharedFiles(): Promise<File[]> {
	if (typeof caches === 'undefined') return [];
	try {
		const cache = await caches.open(SHARE_TARGET_CACHE);
		const files: File[] = [];
		for (const request of await cache.keys()) {
			const response = await cache.match(request);
			if (!response) continue;
			const blob = await response.blob();
			const name = decodeURIComponent(response.headers.get('X-Filename') ?? 'shared-file');
			files.push(new File([blob], name, { type: blob.type }));
		}
		return files;
	} catch {
		return [];
	} finally {
		await caches.delete(SHARE_TARGET_CACHE).catch(() => {});
	}
}
