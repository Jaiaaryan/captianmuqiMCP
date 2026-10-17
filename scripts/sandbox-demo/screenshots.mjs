#!/usr/bin/env node
/**
 * Drives the real dashboard with a browser and saves screenshots of code mode,
 * against a running backend and frontend that have the demo seeded.
 *
 *   AMCP_EMAIL=admin@example.com AMCP_PASSWORD=... node scripts/sandbox-demo/screenshots.mjs
 *
 * Needs the backend (AMCP_API, default http://localhost:4000), the frontend, and Playwright's
 * Chromium (`npx playwright install chromium`), or CHROMIUM_PATH pointing at an installed one.
 * The pictures go to docs/sandbox/screenshots. Any browser console error or uncaught exception
 * is printed and makes the exit code non-zero, so this doubles as a smoke test of the page.
 *
 * Environment: AMCP_UI (default http://localhost:3000), AMCP_EMAIL, AMCP_PASSWORD;
 * optional AMCP_VIEWER_TOKEN for the read-only screenshot, and DEMO_SERVER / BIG_SERVER
 * (the names of the two servers to show; defaults "koch-demo" and "Shop A").
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'docs/sandbox/screenshots');
const BASE = (process.env.AMCP_UI ?? 'http://localhost:3000').replace(/\/$/, '');
const DEMO_SERVER = process.env.DEMO_SERVER ?? 'koch-demo';
const BIG_SERVER = process.env.BIG_SERVER ?? 'Shop A';
const SHOP_CONNECTOR = process.env.SHOP_CONNECTOR ?? 'Shop API (A)';

if (!process.env.AMCP_EMAIL || !process.env.AMCP_PASSWORD) {
  console.error('Set AMCP_EMAIL and AMCP_PASSWORD.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const problems = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => problems.push(`[${label}] uncaught: ${e.message}`));
  page.on('console', (m) => {
    // A 4xx from a request the page makes on purpose is not a defect of the page.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${label}] console: ${m.text()}`);
  });
};
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`saved ${name}.png`);
};
async function chooseServer(page, name) {
  await page.getByRole('combobox', { name: 'MCP server' }).click();
  await page.getByRole('option', { name }).click();
  await page.waitForTimeout(300);
}
const tab = (page, name) => page.getByRole('tab', { name }).click();

// CHROMIUM_PATH: use a Chromium that is already installed instead of Playwright's own build.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // ---- sign in ---------------------------------------------------------------
  // Sign in through the API and hand the session to the page the way the login form does
  // (cookie + localStorage), as the Playwright tests do. The form itself detours through
  // email verification and a first-run questionnaire that a demo account has not done.
  const API = (process.env.AMCP_API ?? 'http://localhost:4000').replace(/\/$/, '');
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.AMCP_EMAIL, password: process.env.AMCP_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`login failed: HTTP ${loginRes.status} ${await loginRes.text()}`);
  const session = await loginRes.json();
  // Tall enough that the result panels are not cut off by the dashboard's own scroll area.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
  await ctx.addCookies([{ name: 'amcp_token', value: session.accessToken, url: BASE }]);
  await ctx.addInitScript(([token, user]) => {
    localStorage.setItem('amcp_token', token);
    localStorage.setItem('amcp_user', user);
  }, [session.accessToken, JSON.stringify({ ...session.user, emailVerified: true })]);
  const page = await ctx.newPage();
  watch(page, 'admin');

  // A server that has both the demo ERP and the shop connector, so a script that uses both can run
  // somewhere. (The demo server only has the ERP.)
  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const connectorList = await api('GET', '/api/connectors');
  const idOf = (name) => connectorList.find((c) => c.name === name)?.id;
  const BOTH_SERVER = 'Demo: ERP + Shop';
  const erpId = idOf('KOCH Demo ERP');
  const shopId = idOf(SHOP_CONNECTOR);
  if (!erpId || !shopId) throw new Error(`Need the connectors "KOCH Demo ERP" and "${SHOP_CONNECTOR}" (seed the demo and the e2e stack first).`);
  const existing = (await api('GET', '/api/mcp-servers')).find((x) => x.name === BOTH_SERVER);
  const bothServer = existing ?? (await api('POST', '/api/mcp-servers', { name: BOTH_SERVER }));
  await api('PUT', `/api/mcp-servers/${bothServer.id}/connectors`, { connectorIds: [erpId, shopId] });
  // A run that stopped half way leaves its script behind; start clean.
  for (const leftover of await api('GET', `/api/sandbox/servers/${bothServer.id}/scripts`)) {
    if (leftover.name === 'erp_products_vs_shop_orders') await api('DELETE', `/api/sandbox/scripts/${leftover.id}`);
  }

  await page.goto(`${BASE}/sandbox`);
  await expect(page.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
  await chooseServer(page, DEMO_SERVER);

  // ---- 1. a saved script, read: the pin on each card and the connectors & tools of the opened one ------------
  await page.getByTestId('script-row').filter({ hasText: 'delayed_orders_last_month' }).click();
  await expect(page.locator('pre').first()).toContainText('erp_orders_export');
  await expect(page.getByTestId('script-uses')).toContainText('erp_orders_export');
  await shot(page, '01-scripts');

  // ---- 2. hover a pin: the connectors and tools, in a tooltip --------------------------------------------------
  await page.locator('li', { hasText: 'top10_customers_by_delay_days' }).getByTestId('script-pin').hover();
  await expect(page.getByTestId('pin-tooltip')).toContainText('erp_customers_list');
  await shot(page, '02-pin-tooltip');
  await page.mouse.move(700, 20);

  // ---- 3. ...and run: the data-flow line is the point of code mode -------------------------------------------
  await page.locator('#script-args').fill('{"asOf": "2026-10-15"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-result')).toContainText('Succeeded', { timeout: 30_000 });
  await expect(page.getByTestId('run-result')).toContainText('"delayedOrders": 922');
  await shot(page, '03-script-run');

  // ---- 4. write a script that uses two connectors, picking them and their tools ------------------------------
  await page.getByRole('button', { name: 'New script' }).click();
  await page.locator('#script-name').fill('erp_products_vs_shop_orders');
  await page.locator('#script-desc').fill('How many products the ERP has and how many recent orders the shop shows');
  await page.getByLabel('Script code').fill(`const shop = await tools.shop_list_orders({ limit: 5 });
const products = await tools.erp_products_list({});
return { shopOrdersSeen: shop.length, erpProducts: products.rows.length };
`);
  const picker = page.getByTestId('uses-picker');
  await picker.getByRole('button', { name: /^KOCH Demo ERP/ }).click();
  await picker.getByLabel('KOCH Demo ERP: erp_products_list').check();
  await picker.getByRole('button', { name: new RegExp(`^${SHOP_CONNECTOR.replace(/[()]/g, '\\$&')}`) }).click();
  await picker.getByLabel(`${SHOP_CONNECTOR}: shop_list_orders`).check();
  await expect(page.getByTestId('uses-count')).toHaveText('2 connectors, 2 tools');
  // Clicking into the list scrolled it; show it from the top.
  await picker.locator('ul').first().evaluate((el) => { el.scrollTop = 0; });
  await picker.scrollIntoViewIfNeeded();
  await shot(page, '04-new-script-picker');

  // ---- 5. saved: the demo server has no shop connector, so it says it cannot run the script here ------------
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('notice')).toContainText('Saved erp_products_vs_shop_orders', { timeout: 15_000 });
  await expect(page.getByTestId('unavailable-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await shot(page, '05-script-needs-a-connector');

  // ---- 6. the filter pop-up ----------------------------------------------------------------------------------
  await page.getByTestId('filter-button').click();
  const dialog = page.getByTestId('filter-dialog');
  await dialog.locator('label').filter({ hasText: new RegExp(`${SHOP_CONNECTOR.replace(/[()]/g, '\\$&')}\\s*\\d+ script`) }).locator('input').check();
  await shot(page, '06-filter-dialog');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('filter-chips')).toBeVisible();
  await shot(page, '07-filtered');
  await page.getByTestId('filter-chips').getByRole('button', { name: 'Clear' }).click();

  // ---- 7. on a server that has both connectors, the same script runs -----------------------------------------
  await chooseServer(page, BOTH_SERVER);
  await page.getByTestId('script-row').filter({ hasText: 'erp_products_vs_shop_orders' }).click();
  await expect(page.getByTestId('unavailable-notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-result')).toContainText('Succeeded', { timeout: 30_000 });
  await expect(page.getByTestId('run-result')).toContainText('erpProducts');
  await shot(page, '08-two-connectors-run');
  // Done with it: delete it, and go back to the demo server.
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByTestId('script-row').filter({ hasText: 'erp_products_vs_shop_orders' })).toHaveCount(0);
  await chooseServer(page, DEMO_SERVER);

  // ---- 4. run history ----------------------------------------------------------
  await tab(page, 'Runs');
  await expect(page.getByTestId('run-row').first()).toBeVisible();
  await page.getByTestId('run-row').first().click();
  await shot(page, '09-runs');

  // ---- 5. the isolation suite: the judges' screen ------------------------------
  await tab(page, 'Isolation tests');
  await page.getByRole('button', { name: 'Run isolation suite' }).click();
  await expect(page.getByTestId('isolation-results')).toContainText('passed', { timeout: 60_000 });
  await expect(page.getByTestId('isolation-row').first()).toBeVisible();
  const rows = await page.getByTestId('isolation-row').count();
  const passed = await page.locator('[data-testid="isolation-row"][data-passed="true"]').count();
  console.log(`isolation suite on screen: ${passed} of ${rows} passed`);
  if (passed !== rows) problems.push(`isolation suite shows ${rows - passed} failing row(s)`);
  await shot(page, '10-isolation');

  // ---- 6. benchmark: the demo question -----------------------------------------
  await tab(page, 'Benchmark');
  await page.getByRole('button', { name: /Use the demo question/ }).click();
  await page.getByRole('button', { name: 'Run both' }).click();
  await expect(page.getByTestId('benchmark-result')).toContainText('Sandbox script', { timeout: 60_000 });
  await shot(page, '11-benchmark');

  // ---- 7. benchmark: the 44 MB response of the brief ---------------------------
  await chooseServer(page, BIG_SERVER);
  await tab(page, 'Benchmark');
  await page.getByRole('combobox', { name: 'Tool to call directly' }).click();
  await page.getByRole('option', { name: 'shop_export_big' }).click();
  await page.locator('#bench-tool-args').fill('{"mb": 44}');
  await page.locator('#bench-code').fill(`// About 44 MB of orders: count the delivered ones inside the gateway.
const rows = await tools.shop_export_big({ mb: 44 });
let delivered = 0;
for (const o of rows) if (o.status === 'delivered') delivered++;
return { rows: rows.length, delivered };
`);
  await page.getByRole('button', { name: 'Run both' }).click();
  await expect(page.getByTestId('reduction-bytes')).toBeVisible({ timeout: 90_000 });
  await shot(page, '12-benchmark-44mb');

  // ---- 8. a viewer: read-only ---------------------------------------------------
  if (process.env.AMCP_VIEWER_TOKEN) {
    const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await viewerCtx.addCookies([{ name: 'amcp_token', value: process.env.AMCP_VIEWER_TOKEN, url: BASE }]);
    await viewerCtx.addInitScript((token) => {
      localStorage.setItem('amcp_token', token);
      localStorage.setItem('amcp_user', JSON.stringify({ id: 'viewer', email: 'viewer@a.test', name: 'Vera Viewer', role: 'VIEWER', organizationId: 'x', emailVerified: true }));
    }, process.env.AMCP_VIEWER_TOKEN);
    const vp = await viewerCtx.newPage();
    watch(vp, 'viewer');
    await vp.goto(`${BASE}/sandbox`);
    await expect(vp.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
    await chooseServer(vp, DEMO_SERVER);
    await vp.getByTestId('script-row').first().click();
    await expect(vp.getByText('Viewers can read scripts but not run them.')).toBeVisible();
    await expect(vp.getByRole('button', { name: 'New script' })).toHaveCount(0);
    await shot(vp, '13-viewer-read-only');
    await viewerCtx.close();
  }

  // ---- 9. a phone ---------------------------------------------------------------
  const phoneCtx = await browser.newContext({ ...(await ctx.storageState().then((s) => ({ storageState: s }))), viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  watch(phone, 'phone');
  await phone.goto(`${BASE}/sandbox`);
  await expect(phone.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
  await chooseServer(phone, DEMO_SERVER);
  await phone.getByTestId('script-row').first().waitFor();
  await shot(phone, '14-phone-scripts');
  await tab(phone, 'Isolation tests');
  await phone.getByRole('button', { name: 'Run isolation suite' }).click();
  await expect(phone.getByTestId('isolation-results')).toContainText('passed', { timeout: 60_000 });
  await shot(phone, '15-phone-isolation');
  await phoneCtx.close();
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('\nNo console errors or uncaught exceptions.');
