import { render } from 'vitest-browser-svelte';
import { expect, test, vi } from 'vitest';
import ImageLightbox from './ImageLightbox.svelte';

test('renders image with correct src and alt', async () => {
	const onclose = vi.fn();
	const screen = render(ImageLightbox, {
		props: {
			src: 'https://example.com/photo.jpg',
			alt: 'A test photo',
			filename: 'photo.jpg',
			sizeBytes: 2048,
			onclose
		}
	});

	await expect.element(screen.getByRole('img', { name: 'A test photo' })).toHaveAttribute('src', 'https://example.com/photo.jpg');
	await expect.element(screen.getByRole('img', { name: 'A test photo' })).toHaveAttribute('alt', 'A test photo');
});

test('displays filename and formatted size', async () => {
	const onclose = vi.fn();
	const screen = render(ImageLightbox, {
		props: {
			src: 'https://example.com/photo.jpg',
			alt: 'Photo',
			filename: 'photo.jpg',
			sizeBytes: 2048,
			onclose
		}
	});

	await expect.element(screen.getByText('photo.jpg')).toBeInTheDocument();
	await expect.element(screen.getByText('(2KB)')).toBeInTheDocument();
});

test('calls onclose when close button is clicked', async () => {
	const onclose = vi.fn();
	const screen = render(ImageLightbox, {
		props: {
			src: 'https://example.com/photo.jpg',
			alt: 'Photo',
			filename: 'photo.jpg',
			sizeBytes: 0,
			onclose
		}
	});

	await screen.getByTitle('Close').click();
	expect(onclose).toHaveBeenCalled();
});
