import { test, expect } from './fixtures';

/** Helper to open a DM with testuser2 via the New DM modal */
async function openDMWithTestuser2(page: import('@playwright/test').Page) {
  await page.locator('button[title="New direct message"]').click();
  const modal = page.locator('.fixed.inset-0');
  const searchInput = modal.locator('input[placeholder="Search for a user..."]');
  await expect(searchInput).toBeVisible({ timeout: 5000 });
  await searchInput.fill('testuser2');

  // Wait for search results to load, then click the result inside the modal
  const resultButton = modal.locator('.max-h-64 button:has-text("testuser2")');
  await expect(resultButton).toBeVisible({ timeout: 5000 });
  await resultButton.click();

  // Wait for DM view to load
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
}

test.describe('Direct Messages', () => {
  test('can open new DM modal', async ({ loggedInPage: page }) => {
    await page.locator('button[title="New direct message"]').click();

    await expect(page.locator('input[placeholder="Search for a user..."]')).toBeVisible({
      timeout: 5000,
    });
  });

  test('can start a DM conversation', async ({ loggedInPage: page }) => {
    await openDMWithTestuser2(page);
  });

  test('can send a DM and it appears', async ({ loggedInPage: page }) => {
    await openDMWithTestuser2(page);

    const dmMsg = `DM test ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(dmMsg, { delay: 10 });
    await textarea.press('Enter');

    await expect(page.getByText(dmMsg)).toBeVisible({ timeout: 10000 });
  });

  test('DM appears in sidebar after sending', async ({ loggedInPage: page }) => {
    await openDMWithTestuser2(page);

    const dmMsg = `Sidebar DM ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(dmMsg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(dmMsg)).toBeVisible({ timeout: 10000 });

    // testuser2 should appear in the DM list in the sidebar
    await expect(page.getByText('Direct Messages')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('nav').getByText('testuser2')).toBeVisible({ timeout: 5000 });
  });
});
