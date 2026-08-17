import { test, expect, testUser, loginViaUI } from './fixtures';

test.describe('Authentication', () => {
  test('can login with valid credentials and sees channel list', async ({ page }) => {
    await loginViaUI(page, testUser);
    // Should see the general channel in the sidebar
    await expect(page.locator('button:has-text("general")')).toBeVisible({ timeout: 10000 });
  });

  test('invalid credentials shows error', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#username').fill('nonexistent');
    await page.locator('#password').fill('wrongpassword');
    await page.locator('button[type="submit"]').click();
    // Should show "Invalid credentials" error
    await expect(page.locator('text=Invalid credentials')).toBeVisible({ timeout: 5000 });
  });

  test('can logout and gets redirected to login', async ({ loggedInPage: page }) => {
    // Open user menu by clicking the avatar button
    const avatar = page.locator('aside button[title="Menu"]');
    await avatar.click();
    // Click sign out
    await page.locator('text=Sign out').click();
    // Should be redirected to login page
    await expect(page.locator('#username')).toBeVisible({ timeout: 10000 });
  });
});
