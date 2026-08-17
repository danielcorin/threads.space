import { test as base, expect, type Page } from '@playwright/test';

const API_URL = 'http://localhost:8788';

export interface TestUser {
  username: string;
  password: string;
}

export const testUser: TestUser = {
  username: 'testuser',
  password: 'testpass123',
};

export const testUser2: TestUser = {
  username: 'testuser2',
  password: 'testpass123',
};

/**
 * Login via the API and set both the session cookie and localStorage
 * so the client app recognizes the session on page load.
 */
async function loginViaAPI(page: Page, user: TestUser) {
  // Hit the API directly to login and get the session cookie + user data
  const res = await page.request.post(`${API_URL}/auth/login`, {
    data: { username: user.username, password: user.password },
  });
  expect(res.ok()).toBeTruthy();

  const userData = await res.json();

  // Extract session cookie and set it for localhost
  const cookies = res.headers()['set-cookie'];
  if (cookies) {
    const match = cookies.match(/session=([^;]+)/);
    if (match) {
      await page.context().addCookies([
        {
          name: 'session',
          value: match[1],
          domain: 'localhost',
          path: '/',
        },
      ]);
    }
  }

  // The app also checks localStorage for cached user data.
  // We need to navigate first to set localStorage on the right origin,
  // then set it before the app's checkSession runs.
  await page.goto('/');

  // Set localStorage before the app fully initializes
  await page.evaluate((u) => {
    localStorage.setItem('threads_user', JSON.stringify(u));
  }, userData);

  // Reload so the app picks up localStorage + cookie
  await page.reload();
}

/** Login via the UI form. */
async function loginViaUI(page: Page, user: TestUser) {
  await page.goto('/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('button[type="submit"]').click();
  // Wait for redirect to main page - we should see channels or the welcome message
  await expect(page.getByText('Channels', { exact: true })).toBeVisible({ timeout: 10000 });
}

export const test = base.extend<{ loggedInPage: Page }>({
  /** A page that is already logged in as testUser. */
  loggedInPage: async ({ page }, use) => {
    await loginViaAPI(page, testUser);
    // Wait for the app to load (channel list or welcome message)
    await expect(page.getByText('Channels', { exact: true })).toBeVisible({ timeout: 10000 });
    await use(page);
  },
});

export { expect, loginViaAPI, loginViaUI };
