import { test, expect } from './fixtures';

// Helper: wait for the thread panel to be visible
async function expectThreadPanelOpen(page: import('@playwright/test').Page) {
  await expect(page.locator('aside .font-semibold').getByText('Thread', { exact: true })).toBeVisible({ timeout: 5000 });
}

test.describe('Thread replies', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    await page.locator('button:has-text("general")').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
  });

  test('can click reply on a message and thread panel opens', async ({ loggedInPage: page }) => {
    const msg = `Reply target ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Hover over the message to show action buttons then click reply
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title="Reply in thread"]').click();

    await expectThreadPanelOpen(page);
  });

  test('can send a reply in thread and reply appears', async ({ loggedInPage: page }) => {
    const msg = `Parent for reply ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Open thread
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title="Reply in thread"]').click();
    await expectThreadPanelOpen(page);

    // Send a reply in the thread panel
    const replyText = `Reply ${Date.now()}`;
    const threadTextarea = page.locator('aside textarea');
    await expect(threadTextarea).toBeVisible({ timeout: 5000 });
    await threadTextarea.click();
    await threadTextarea.pressSequentially(replyText, { delay: 10 });
    await threadTextarea.press('Enter');

    // Reply should appear in the thread panel
    await expect(page.locator('aside').getByText(replyText)).toBeVisible({ timeout: 10000 });
  });

  test('reply count shows on parent message', async ({ loggedInPage: page }) => {
    const msg = `Reply count test ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Open thread and send a reply
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title="Reply in thread"]').click();
    await expectThreadPanelOpen(page);

    const replyText = `A reply ${Date.now()}`;
    const threadTextarea = page.locator('aside textarea');
    await expect(threadTextarea).toBeVisible({ timeout: 5000 });
    await threadTextarea.click();
    await threadTextarea.pressSequentially(replyText, { delay: 10 });
    await threadTextarea.press('Enter');
    await expect(page.locator('aside').getByText(replyText)).toBeVisible({ timeout: 10000 });

    // Close thread panel
    await page.locator('aside button[title="Close thread"]').click();
    await expect(page.locator('aside .font-semibold').getByText('Thread', { exact: true })).not.toBeVisible({ timeout: 5000 });

    // Parent message should now show "1 reply" - scope to the specific message container
    const parentMsgContainer = page.locator(`[id^="msg-"]`).filter({ hasText: msg });
    await expect(parentMsgContainer.getByText('1 reply')).toBeVisible({ timeout: 10000 });
  });

  test('can close thread panel', async ({ loggedInPage: page }) => {
    const msg = `Close panel test ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.pressSequentially(msg, { delay: 10 });
    await textarea.press('Enter');
    await expect(page.getByText(msg)).toBeVisible({ timeout: 10000 });

    // Open thread
    await page.getByText(msg).first().hover();
    await page.locator('.message-actions button[title="Reply in thread"]').click();
    await expectThreadPanelOpen(page);

    // Close thread panel using the X button
    await page.locator('aside button[title="Close thread"]').click();
    await expect(page.locator('aside .font-semibold').getByText('Thread', { exact: true })).not.toBeVisible({ timeout: 5000 });
  });

  test('can title a thread and resolved titled roots collapse to the title', async ({ loggedInPage: page }) => {
    const msg = `Title and collapse ${Date.now()}`;
    const title = `Resolved thread ${Date.now()}`;
    const textarea = page.locator('textarea').first();
    await textarea.fill(msg);
    await textarea.press('Enter');
    const messageText = page.getByText(msg, { exact: true }).first();
    await expect(messageText).toBeVisible({ timeout: 10000 });

    const messageContainer = messageText.locator('xpath=ancestor::div[starts-with(@id, "msg-")]');
    const messageContainerId = await messageContainer.getAttribute('id');
    expect(messageContainerId).toBeTruthy();
    const root = page.locator(`#${messageContainerId}`);

    await messageText.hover();
    await root.locator('.message-actions button[title="Reply in thread"]').click();
    await expectThreadPanelOpen(page);

    await page.locator('aside button[title="Set thread title"]').click();
    await page.locator('aside input[aria-label="Thread title"]').fill(title);
    await page.locator('aside button[title="Save thread title"]').click();
    await expect(page.locator('aside').getByText(title, { exact: true })).toBeVisible({ timeout: 10000 });

    await page.locator('aside button[title="Close thread"]').click();
    await messageText.hover();
    await root.locator('.message-actions button[title="Mark as resolved"]').click();

    await expect(root.getByText(title, { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(root.getByText(msg, { exact: true })).not.toBeVisible();

    await root.getByTitle('Open resolved thread').click();
    await expect(page.locator('aside').getByText(title, { exact: true })).toBeVisible();
    await expect(page.locator('aside').getByText(msg, { exact: true })).toBeVisible();
  });
});
