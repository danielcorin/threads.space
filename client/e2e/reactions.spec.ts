import { test, expect } from './fixtures';

test.describe('Reactions', () => {
  test('can add a reaction to a message', async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

    // Send a message
    const msg = `React test ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Hover over the message to show action buttons
    await page.getByText(msg).first().hover();

    // Click one of the quick emoji buttons in the action bar
    await page.locator('.message-actions button[title^="React with"]').first().click();

    // A reaction badge should appear on the message
    const msgContainer = page.locator(`[id^="msg-"]`).filter({ hasText: msg });
    await expect(msgContainer.locator('button:has-text("1")')).toBeVisible({ timeout: 5000 });
  });

  test('can remove own reaction by clicking it again', async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

    // Send a message
    const msg = `Remove react ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Add a reaction via quick emoji button
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title^="React with"]').first().click();

    // Wait for reaction to appear
    const msgContainer = page.locator(`[id^="msg-"]`).filter({ hasText: msg });
    const reactionBtn = msgContainer.locator('button:has-text("1")').first();
    await expect(reactionBtn).toBeVisible({ timeout: 5000 });

    // Click the reaction to remove it
    await reactionBtn.click();

    // The reaction count should disappear
    await expect(reactionBtn).not.toBeVisible({ timeout: 5000 });
  });
});
