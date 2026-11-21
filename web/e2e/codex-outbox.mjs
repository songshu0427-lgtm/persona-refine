// Usage: node e2e/codex-outbox.mjs <isolated Vite origin> <screenshot directory>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const [origin, shots] = process.argv.slice(2);
assert(origin && shots);
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const lang of ["en", "zh-Hans", "ja"]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // No fixture request is allowed to reach a hub, regardless of the dev server's proxy configuration.
    await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto(`${origin}/e2e/codex-outbox-fixture.html?lang=${lang}`);
    await page.locator('[data-outbox="unknown"] [role="status"]').waitFor();
    await page.locator('[data-outbox="unknown"] [role="status"] button').first().waitFor();
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    assert.equal(await page.locator("[data-user-bubble]").count(), 7);
    assert.equal(await page.locator('[data-outbox="queued"] [role="status"]').count(), 1);
    assert.equal(await page.locator('[data-outbox="accepted"] [role="status"]').count(), 1);
    assert.equal(await page.locator('[data-outbox="failed"] [role="alert"]').count(), 1);
    assert.equal(await page.locator('[data-outbox="cancelled"] [role="alert"]').count(), 1);
    assert.equal(await page.locator('[data-outbox="unknown"] [role="status"] button').count(), 2); // Check/Delete, no unsafe Retry
    assert.equal(await page.locator('[data-outbox="photo-queued"] [role="status"]').count(), 1);
    assert.equal(await page.locator('[data-outbox="photo-failed"] [role="alert"] button').count(), 1); // Delete only; no missing-photo retry
    assert.equal(await page.locator('[data-outbox="photo-queued"] img, [data-outbox="photo-failed"] img').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(shots, `web-codex-outbox-${lang}-${theme}.png`), fullPage: true });
    await page.evaluate(() => document.documentElement.style.setProperty("--text-scale", "1.4"));
    await page.screenshot({ path: join(shots, `web-codex-outbox-${lang}-${theme}-large.png`), fullPage: true });
    console.log(`PASS ${lang} ${theme}: queued, accepted, failed, cancelled, unknown, restored photos; normal/large screenshots`);
    await context.close();
  }
} finally { await browser.close(); }
