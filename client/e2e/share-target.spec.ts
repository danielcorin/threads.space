import { test, expect } from './fixtures';

test.describe('Share target', () => {
  test('content shared from the OS share sheet lands in the chosen channel', async ({ loggedInPage: page }) => {
    const channelName = `share-${Date.now()}`;
    const created = await page.request.post('http://localhost:8788/channels', { data: { name: channelName } });
    expect(created.ok(), await created.text()).toBeTruthy();

    // The share sheet only reaches the app through sw.js, so wait for it to control the page.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return;
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
      );
    });

    // Submit the same multipart POST Android sends for the manifest's share_target.
    const sharedUrl = `https://example.com/shared-${Date.now()}`;
    await page.evaluate(
      ({ url }) => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/share-target';
        form.enctype = 'multipart/form-data';
        for (const [name, value] of Object.entries({ title: 'Shared article', url })) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value;
          form.append(input);
        }
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.name = 'files';
        fileInput.id = 'share-files';
        form.append(fileInput);
        document.body.append(form);
      },
      { url: sharedUrl }
    );
    await page.locator('#share-files').setInputFiles({
      name: 'shared-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('from the share sheet'),
    });
    await page.evaluate(() => document.querySelector('form[action="/share-target"]')!.submit());

    const dialog = page.getByRole('heading', { name: 'Share to…' });
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(sharedUrl)).toBeVisible();
    await expect(page.getByText('shared-note.txt')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');

    await page.getByPlaceholder('Find a channel or person...').fill(channelName);
    await page.getByPlaceholder('Find a channel or person...').press('Enter');

    const textarea = page.locator('textarea').first();
    await expect(textarea).toHaveValue(`Shared article\n${sharedUrl}`, { timeout: 10000 });
    await expect(page.getByTitle('Send message')).toBeEnabled({ timeout: 10000 });
    await textarea.press('Enter');

    const sent = page.locator('[id^="msg-"]').filter({ hasText: sharedUrl });
    await expect(sent).toBeVisible({ timeout: 10000 });
    await expect(sent.getByText('shared-note.txt')).toBeVisible();
  });
});
