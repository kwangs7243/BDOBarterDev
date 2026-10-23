import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

assert.equal(process.env.BDO_EXTERNAL_APP, "1", "requires an explicitly isolated packaged app");
const base = process.env.BDO_TEST_URL;
assert.ok(base?.startsWith("http://127.0.0.1:"));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BDO_NODE_MODULES
  ? require.resolve("playwright", { paths: [process.env.BDO_NODE_MODULES] }) : "playwright");
const browser = await chromium.launch({
  executablePath: process.env.BDO_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (new URL(request.url()).origin !== new URL(base).origin) external.push(request.url());
  });
  const loaded = () => page.waitForFunction(() => document.querySelector("#content")?.getAttribute("aria-busy") === "false");
  await page.goto(base);
  assert.equal(await page.locator(".barter-card").count(), 1);
  const output = process.env.BDO_LIVE_REPORT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, "packaged-portal.png"), fullPage: true });
  }
  await page.locator(".alchemy-card").click();
  await loaded();
  assert.equal(await page.locator(".product-card img").count(), 26);
  await page.locator(".product-card img").evaluateAll(images => images.forEach(image => image.loading = "eager"));
  await page.waitForFunction(() => [...document.querySelectorAll(".product-card img")].every(image => image.complete && image.naturalWidth > 0));
  if (output) await page.screenshot({ path: join(output, "packaged-alchemy.png"), fullPage: true });
  await page.locator("[data-nav=inventory]").click();
  await loaded();
  assert.equal(await page.getByRole("spinbutton", { name: "맑은 액체 시약 실제 재고", exact: true }).inputValue(), "7");
  await page.locator('a[href="/barter/"]').click();
  await page.waitForFunction(() => document.querySelector("#app-content")?.getAttribute("aria-busy") === "false");
  await page.locator('a[href="/alchemy/"]').click();
  await loaded();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], "installed UI must not fetch remote images or app services");
  console.log(JSON.stringify({ packagedPortal: true, packagedAlchemy: true, icons: 26, actualStock: 7, workspaceNavigation: true, externalRequests: 0 }));
} finally {
  await browser.close();
}
