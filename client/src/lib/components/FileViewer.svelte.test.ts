import { render } from 'vitest-browser-svelte';
import { expect, test, vi, describe, beforeEach } from 'vitest';
import FileViewer from './FileViewer.svelte';

// Mock fetch for text-based sub-viewers so they don't hit the network.
beforeEach(() => {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		return new Response('mock body', { status: 200, headers: { 'content-type': 'text/plain' } });
	});
});

describe('FileViewer modal', () => {
	test('renders filename and size in header', async () => {
		const onclose = vi.fn();
		const screen = render(FileViewer, {
			props: {
				url: 'https://example.com/file.txt',
				contentType: 'text/plain',
				filename: 'file.txt',
				sizeBytes: 1024,
				onclose
			}
		});
		await expect.element(screen.getByText('file.txt')).toBeInTheDocument();
	});

	test('clicking close button calls onclose', async () => {
		const onclose = vi.fn();
		const screen = render(FileViewer, {
			props: {
				url: 'https://example.com/file.txt',
				contentType: 'text/plain',
				filename: 'file.txt',
				sizeBytes: 0,
				onclose
			}
		});
		await screen.getByTitle('Close').click();
		expect(onclose).toHaveBeenCalled();
	});

	test('clicking backdrop calls onclose', async () => {
		const onclose = vi.fn();
		const screen = render(FileViewer, {
			props: {
				url: 'https://example.com/file.txt',
				contentType: 'text/plain',
				filename: 'file.txt',
				sizeBytes: 0,
				onclose
			}
		});
		const backdrop = screen.baseElement.querySelector('[data-testid="file-viewer-backdrop"]') as HTMLElement;
		expect(backdrop).not.toBeNull();
		backdrop.click();
		expect(onclose).toHaveBeenCalled();
	});

	test('escape key calls onclose', async () => {
		const onclose = vi.fn();
		render(FileViewer, {
			props: {
				url: 'https://example.com/file.txt',
				contentType: 'text/plain',
				filename: 'file.txt',
				sizeBytes: 0,
				onclose
			}
		});
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(onclose).toHaveBeenCalled();
	});

	test('audio content type renders an audio element', async () => {
		const onclose = vi.fn();
		const screen = render(FileViewer, {
			props: {
				url: 'https://example.com/song.mp3',
				contentType: 'audio/mpeg',
				filename: 'song.mp3',
				sizeBytes: 1024,
				onclose
			}
		});
		const audio = screen.baseElement.querySelector('audio');
		expect(audio).not.toBeNull();
		expect(audio!.getAttribute('src')).toBe('https://example.com/song.mp3');
	});

	test('pdf content type renders an iframe', async () => {
		const onclose = vi.fn();
		const screen = render(FileViewer, {
			props: {
				url: 'https://example.com/doc.pdf',
				contentType: 'application/pdf',
				filename: 'doc.pdf',
				sizeBytes: 1024,
				onclose
			}
		});
		const iframe = screen.baseElement.querySelector('iframe');
		expect(iframe).not.toBeNull();
		expect(iframe!.getAttribute('src')).toBe('https://example.com/doc.pdf');
	});

	test('unsupported content type renders the fallback panel', async () => {
		const onclose = vi.fn();
		const screen = render(FileViewer, {
			props: {
				url: 'https://example.com/archive.zip',
				contentType: 'application/zip',
				filename: 'archive.zip',
				sizeBytes: 1024,
				onclose
			}
		});
		await expect
			.element(screen.getByText(/preview not supported/i))
			.toBeInTheDocument();
	});

	test('text content type triggers a fetch for the body', async () => {
		const onclose = vi.fn();
		render(FileViewer, {
			props: {
				url: 'https://example.com/note.txt',
				contentType: 'text/plain',
				filename: 'note.txt',
				sizeBytes: 1024,
				onclose
			}
		});
		// Wait a microtask for the effect to run.
		await new Promise((r) => setTimeout(r, 50));
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/note.txt?preview=1',
			expect.objectContaining({ credentials: 'include', cache: 'reload' })
		);
	});

	test('json content type fetches the body', async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
			return new Response('{"hello":"world"}', { status: 200 });
		});
		const onclose = vi.fn();
		render(FileViewer, {
			props: {
				url: 'https://example.com/data.json',
				contentType: 'application/json',
				filename: 'data.json',
				sizeBytes: 17,
				onclose
			}
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/data.json?preview=1',
			expect.objectContaining({ credentials: 'include', cache: 'reload' })
		);
	});

	test('csv content type fetches the body', async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
			return new Response('a,b\n1,2', { status: 200 });
		});
		const onclose = vi.fn();
		render(FileViewer, {
			props: {
				url: 'https://example.com/data.csv',
				contentType: 'text/csv',
				filename: 'data.csv',
				sizeBytes: 7,
				onclose
			}
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/data.csv?preview=1',
			expect.objectContaining({ credentials: 'include', cache: 'reload' })
		);
	});

	test('markdown content type fetches the body', async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
			return new Response('# Hello\n\nThis is **bold**.', { status: 200 });
		});
		const onclose = vi.fn();
		render(FileViewer, {
			props: {
				url: 'https://example.com/readme.md',
				contentType: 'text/markdown',
				filename: 'readme.md',
				sizeBytes: 30,
				onclose
			}
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/readme.md?preview=1',
			expect.objectContaining({ credentials: 'include', cache: 'reload' })
		);
	});
});
