import { expect, test, type Page } from '@playwright/test';

/**
 * A demo instance (`GET /api/public/demo` → enabled) lists ready-made
 * accounts under the sign-in form. "Use" fills the form and submits it
 * through the normal sign-in; an instance that is not a demo shows nothing.
 */
const DEMO = {
  enabled: true,
  accounts: [
    { email: 'alice@demo.test', password: 'Alice#Demo1', name: 'alice', role: 'ADMIN', workspace: 'A' },
    { email: 'carol@demo.test', password: 'Carol#Demo1', name: 'carol', role: 'VIEWER', workspace: 'A' },
    { email: 'bob@demo.test', password: 'Bob#Demo1', name: 'bob', role: 'ADMIN', workspace: 'B' },
  ],
  mcp: { A: '/mcp/ws-a-111', B: '/mcp/ws-b-222' },
};

async function mockApi(page: Page, demo: unknown) {
  const logins: Array<{ email?: string; password?: string }> = [];
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/health/server-info') {
      return route.fulfill({
        json: { deploymentMode: 'self-hosted', hasUsers: true, registrationEnabled: false, ssoProviders: [] },
      });
    }
    if (p === '/api/public/demo') return route.fulfill({ json: demo });
    if (p === '/api/auth/login') {
      logins.push(route.request().postDataJSON());
      // Refused, so the page stays put and the request can be inspected.
      return route.fulfill({ status: 401, json: { statusCode: 401, message: 'Invalid credentials' } });
    }
    return route.fulfill({ json: {} });
  });
  return logins;
}

test.describe('login demo accounts', () => {
  test('lists the accounts and signs in with one', async ({ page }) => {
    const logins = await mockApi(page, DEMO);
    await page.goto('/login');

    const root = page.getByTestId('demo-root');
    await expect(root).toBeVisible();
    await expect(root.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByTestId('demo-row-A-admin')).toContainText('alice');
    await expect(page.getByTestId('demo-row-A-viewer')).toContainText('carol');
    await expect(page.getByTestId('demo-row-B-admin')).toContainText('bob');
    await expect(page.getByTestId('demo-mcp-A')).toContainText('/mcp/ws-a-111');
    await expect(page.getByTestId('demo-mcp-B')).toContainText('/mcp/ws-b-222');

    // Hidden until revealed.
    await expect(root).not.toContainText('Alice#Demo1');
    await page.getByRole('button', { name: 'Show password for alice' }).click();
    await expect(page.getByTestId('demo-row-A-admin')).toContainText('Alice#Demo1');

    const loginRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/auth/login');
    await page.getByRole('button', { name: 'Use alice' }).click();
    await loginRequest;

    await expect(page.locator('#auth-email')).toHaveValue('alice@demo.test');
    await expect(page.locator('#auth-password')).toHaveValue('Alice#Demo1');
    expect(logins).toEqual([{ email: 'alice@demo.test', password: 'Alice#Demo1' }]);
  });

  test('shows nothing when the instance is not a demo', async ({ page }) => {
    await mockApi(page, { enabled: false });
    const demoAnswered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/public/demo');
    await page.goto('/login');
    await demoAnswered;
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByTestId('demo-root')).toHaveCount(0);
  });
});
