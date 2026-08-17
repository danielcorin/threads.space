import { test, expect } from './fixtures';

test.describe('Search', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    // Navigate to general channel and send a unique message to search for
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
  });

  test('can open search with keyboard shortcut', async ({ loggedInPage: page }) => {
    await page.keyboard.press('Meta+k');
    await expect(page.locator('input[placeholder="Search messages..."]')).toBeVisible({
      timeout: 5000,
    });
  });

  test('can search for a message and see results', async ({ loggedInPage: page }) => {
    // Send a unique message
    const searchTerm = `searchable-${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(searchTerm, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(searchTerm)).toBeVisible({ timeout: 10000 });

    // Open search
    await page.keyboard.press('Meta+k');
    const searchInput = page.locator('input[placeholder="Search messages..."]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Type search term
    await searchInput.fill(searchTerm);
    await searchInput.press('Enter');

    // Should see the message in results
    await expect(page.locator(`text=${searchTerm}`).first()).toBeVisible({ timeout: 10000 });
  });

  test('can close search with Escape', async ({ loggedInPage: page }) => {
    await page.keyboard.press('Meta+k');
    const searchInput = page.locator('input[placeholder="Search messages..."]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeVisible({ timeout: 5000 });
  });
});
