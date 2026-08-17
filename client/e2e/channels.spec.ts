import { test, expect } from './fixtures';

test.describe('Channel management', () => {
  test('can see channel list in sidebar', async ({ loggedInPage: page }) => {
    // The sidebar should show the "Channels" label and the general channel
    await expect(page.getByText('Channels', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('nav button:has-text("general")')).toBeVisible();
  });

  test('can switch between channels', async ({ loggedInPage: page }) => {
    // Create a second channel via API
    const loginRes = await page.request.post('http://localhost:8788/auth/login', {
      data: { username: 'testuser', password: 'testpass123' },
    });
    const cookies = loginRes.headers()['set-cookie'];
    const match = cookies?.match(/session=([^;]+)/);
    if (match) {
      await page.request.post('http://localhost:8788/channels', {
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${match[1]}`,
        },
        data: { name: 'random', description: 'Random chat' },
      });
    }

    // Reload to pick up the new channel
    await page.reload();
    await expect(page.locator('nav button:has-text("general")')).toBeVisible({ timeout: 10000 });

    // Click on general channel
    await page.locator('nav button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

    // Verify the random channel exists and switch to it
    await expect(page.locator('nav button:has-text("random")')).toBeVisible({ timeout: 5000 });
    await page.locator('nav button:has-text("random")').first().click();

    // Should see the composer for the new channel
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
  });

  test('can create a new channel', async ({ loggedInPage: page }) => {
    // Click the create channel button (+ icon next to "Channels" header)
    await page.locator('button[title="Create channel"]').click();

    // The create channel modal should appear
    await expect(page.getByText('Create a channel')).toBeVisible({ timeout: 5000 });

    // Fill in the channel name
    const channelName = `test-${Date.now()}`;
    await page.locator('#channel-name').fill(channelName);

    // Submit the form
    await page.locator('button:has-text("Create")').click();

    // The modal should close and we should be in the new channel
    await expect(page.getByText('Create a channel')).not.toBeVisible({ timeout: 5000 });

    // The new channel should appear in the sidebar (scope to nav)
    await expect(page.locator(`nav button:has-text("${channelName}")`)).toBeVisible({ timeout: 10000 });
  });
});
