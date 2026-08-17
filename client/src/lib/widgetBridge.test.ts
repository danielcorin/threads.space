import { describe, it, expect } from 'vitest';
import { buildWidgetDataUrl } from './widgetBridge.js';

describe('buildWidgetDataUrl', () => {
	const cases = [
		{ apiBase: '/api', label: 'relative apiBase (dev)' },
		{ apiBase: 'https://threads.example.com/api', label: 'absolute apiBase (production)' }
	];

	for (const { apiBase, label } of cases) {
		describe(label, () => {
			it('allows simple data paths', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', '/kv/some-key')).toBe(
					`${apiBase}/widgets/w1/data/kv/some-key`
				);
				expect(buildWidgetDataUrl(apiBase, 'w1', '/worker/items?limit=5')).toBe(
					`${apiBase}/widgets/w1/data/worker/items?limit=5`
				);
			});

			it('rejects parent-directory traversal', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', '/../../channels/dm-id/messages')).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', '/kv/../../../users/me')).toBeNull();
			});

			it('rejects encoded traversal', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', '/%2e%2e/%2e%2e/channels/x/messages')).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', '/%2E%2E/secrets')).toBeNull();
			});

			it('rejects backslash segments', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', '/..\\..\\channels')).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', '\\evil.example')).toBeNull();
			});

			it('rejects non-/-prefixed and non-string paths', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', 'kv/key')).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', 'https://evil.example/x')).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', undefined)).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', 42)).toBeNull();
				expect(buildWidgetDataUrl(apiBase, 'w1', { path: '/kv/x' })).toBeNull();
			});

			it('rejects protocol-relative URLs', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', '//evil.example/steal')).toBeNull();
			});

			it('allows the bare data root', () => {
				expect(buildWidgetDataUrl(apiBase, 'w1', '/')).toBe(`${apiBase}/widgets/w1/data/`);
			});
		});
	}
});
