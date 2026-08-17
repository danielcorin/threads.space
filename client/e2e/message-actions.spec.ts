import { test, expect } from './fixtures';

test.describe('Message editing', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
  });

  test('can edit own message', async ({ loggedInPage: page }) => {
    // Send a message
    const original = `Edit me ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(original, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(original)).toBeVisible({ timeout: 10000 });

    // Hover and click edit
    await page.getByText(original).first().hover();
    await page.locator('.message-actions button[title="Edit"]').click();

    // Should see edit mode indicator
    await expect(page.getByText('Editing message')).toBeVisible({ timeout: 5000 });

    // Clear and type new content
    const editTextarea = page.locator('textarea').first();
    await editTextarea.click();
    await editTextarea.press('Meta+a');
    const edited = `Edited ${Date.now()}`;
    await editTextarea.pressSequentially(edited, { delay: 10 });
    await editTextarea.press('Enter');

    // Edited message should appear
    await expect(page.getByText(edited)).toBeVisible({ timeout: 10000 });
    // Original text should be gone
    await expect(page.getByText(original)).not.toBeVisible({ timeout: 5000 });
  });

  test('can cancel edit with Escape', async ({ loggedInPage: page }) => {
    const msg = `Cancel edit ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Start editing
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title="Edit"]').click();
    await expect(page.getByText('Editing message')).toBeVisible({ timeout: 5000 });

    // Cancel with Escape
    await page.keyboard.press('Escape');
    await expect(page.getByText('Editing message')).not.toBeVisible({ timeout: 5000 });

    // Original message should still be there
    await expect(page.getByText(msg)).toBeVisible();
  });
});

test.describe('Message deletion', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
  });

  test('can delete own message', async ({ loggedInPage: page }) => {
    const msg = `Delete me ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Set up dialog handler before triggering delete
    page.on('dialog', (dialog) => dialog.accept());

    // Hover and click delete
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title="Delete"]').click();

    // Message should show as deleted
    await expect(page.getByText('[deleted]')).toBeVisible({ timeout: 5000 });
  });
});
