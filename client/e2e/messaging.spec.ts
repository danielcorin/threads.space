import { test, expect } from './fixtures';

test.describe('Core messaging', () => {
  test('can select a channel and see messages area', async ({ loggedInPage: page }) => {
    // Click on the general channel
    await page.locator('button:has-text("general")').first().click();
    // Should see the message composer textarea
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
  });

  test('can type and send a message', async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

    const messageText = `Hello E2E ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(messageText, { delay: 10 });
    await textarea.press('Enter');

    // Message should appear in the message list
    await expect(page.getByText(messageText)).toBeVisible({ timeout: 10000 });
  });

  test('can see own message with username displayed', async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

    const messageText = `Username check ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(messageText, { delay: 10 });
    await textarea.press('Enter');

    await expect(page.getByText(messageText)).toBeVisible({ timeout: 10000 });
    // The username should be visible near the message (in the message item header)
    const msgContainer = page.locator(`[id^="msg-"]`).filter({ hasText: messageText });
    await expect(msgContainer.locator('.font-semibold')).toContainText('testuser');
  });

  test('message appears in real-time without refresh', async ({ loggedInPage: page, browser }) => {
    test.setTimeout(60000);
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

    // Open a second browser context as testuser2
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    // Login testuser2 via API and set localStorage
    const loginRes = await page2.request.post('http://localhost:8788/auth/login', {
      data: { username: 'testuser2', password: 'testpass123' },
    });
    const userData = await loginRes.json();
    const cookies = loginRes.headers()['set-cookie'];
    if (cookies) {
      const match = cookies.match(/session=([^;]+)/);
      if (match) {
        await context2.addCookies([
          { name: 'session', value: match[1], domain: 'localhost', path: '/' },
        ]);
      }
    }
    await page2.goto('http://localhost:5173');
    await page2.evaluate((u) => {
      localStorage.setItem('threads_user', JSON.stringify(u));
    }, userData);
    await page2.reload();

    await expect(page2.getByText('Channels', { exact: true })).toBeVisible({ timeout: 10000 });
    await page2.locator('button:has-text("general")').first().click();
    await expect(page2.locator('textarea')).toBeVisible({ timeout: 10000 });

    // testuser2 sends a message
    const realtimeMsg = `Realtime ${Date.now()}`;
    const textarea2 = page2.locator('textarea').first();
    await textarea2.click();
    await textarea2.pressSequentially(realtimeMsg, { delay: 10 });
    await textarea2.press('Enter');

    // The message should appear on page1 via WebSocket without refresh
    await expect(page.getByText(realtimeMsg)).toBeVisible({ timeout: 15000 });

    await context2.close();
  });
});
