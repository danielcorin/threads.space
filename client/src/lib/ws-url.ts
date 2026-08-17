export function websocketOrigin(): string {
	const apiUrl = import.meta.env.VITE_API_URL;
	if (apiUrl) {
		const url = new URL(apiUrl);
		const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${url.host}`;
	}

	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const hostname = location.hostname;
	if (
		(hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') &&
		location.port !== '8788'
	) {
		const host = hostname === '::1' ? '[::1]' : hostname;
		return `${protocol}//${host}:8788`;
	}

	return `${protocol}//${location.host}`;
}
