import { render } from 'vitest-browser-svelte';
import { afterEach, expect, test, vi } from 'vitest';
import MfaSetupKey from './MfaSetupKey.svelte';

const secret = 'JBSWY3DPEHPK3PXP';
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
	if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
	else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
});

test('copies the manual enrollment key with one click', async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
	const screen = render(MfaSetupKey, { props: { secret } });
	await screen.getByRole('button', { name: 'Copy key' }).click();
	expect(writeText).toHaveBeenCalledWith(secret);
	await expect.element(screen.getByRole('status')).toHaveTextContent('Key copied');
});

test('selects the key for manual copying if clipboard access is denied', async () => {
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) }
	});
	const screen = render(MfaSetupKey, { props: { secret } });
	await screen.getByRole('button', { name: 'Copy key' }).click();
	const input = screen.getByRole('textbox', { name: 'Authenticator setup key' }).element() as HTMLTextAreaElement;
	expect(input.readOnly).toBe(true);
	expect(document.activeElement).toBe(input);
	expect(input.selectionStart).toBe(0);
	expect(input.selectionEnd).toBe(secret.length);
	await expect.element(screen.getByRole('status')).toHaveTextContent('Touch and hold');
});
