import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.BDO_NODE_MODULES
    ? require.resolve("playwright", { paths: [process.env.BDO_NODE_MODULES] })
    : "playwright",
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temp = await mkdtemp(join(tmpdir(), "bdo-alchemy-audit-"));
const out = process.env.BDO_ALCHEMY_REPORT_DIR ?? join(temp, "report");
await mkdir(out, { recursive: true });
const base = "http://127.0.0.1:18697";
assert.equal(
  await fetch(base + "/suite-health")
    .then(() => true)
    .catch(() => false),
  false,
  "test port occupied",
);
const data = JSON.parse(
  await readFile(join(root, "alchemy/data/catalog.json"), "utf8"),
);
const ids = Object.fromEntries(data.items.map((i) => [i.name, i.item_id]));
const rage = ids["격노의 영약"];
const python = `
from pathlib import Path
from local_app.backend.app import create_app
from alchemy.storage import encode
import json
app=create_app(r'${join(temp, "barter.sqlite3")}', testing=True)
store=app.extensions['alchemy_storage']
old=json.loads(Path('alchemy/data/catalog-bases.json').read_text(encoding='utf-8'))['catalogs'][0]
saved=json.loads(encode(old))
recipe=next(r for r in saved['recipes'] if r['recipe_id']=='${rage}-10')
recipe['inputs'][0]['quantity']+=1
with store.connect() as db:
    db.executemany('INSERT INTO settings VALUES (?,?)',[('catalog',encode(saved)),('catalog_base',encode(old))])
app.run(host='127.0.0.1',port=18697,use_reloader=False)
`;
let server = spawn(process.env.PYTHON ?? "python", ["-B", "-c", python], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, LOCALAPPDATA: temp, PYTHONDONTWRITEBYTECODE: "1" },
  }),
  browser;
try {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(base + "/suite-health")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    assert.equal(server.exitCode, null, "server exited");
    await delay(100);
  }
  browser = await chromium.launch({
    executablePath:
      process.env.BDO_CHROME ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  const loaded = () =>
    page.waitForFunction(
      () =>
        document.querySelector("#content")?.getAttribute("aria-busy") ===
        "false",
    );
  const stored = () =>
    page.waitForFunction(
      () => document.querySelector("#status")?.dataset.kind === "success",
    );
  const state = () => fetch(base + "/api/alchemy/state").then((r) => r.json());
  async function change(action, fields) {
    const snapshot = await state();
    const response = await fetch(base + "/api/alchemy/mutations/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        mutationId: crypto.randomUUID(),
        baseRevision: snapshot.revision,
        ...fields,
      }),
    });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  }
  await page.goto(base + "/alchemy/settings");
  await loaded();
  assert.equal(await page.locator(".catalog-conflict").count(), 1);
  await page.locator(".catalog-conflict summary").click();
  await page.locator("#catalog-update-form select").selectOption("upstream");
  await page
    .getByRole("button", { name: "선택 병합하고 이전 상태 백업" })
    .click();
  await stored();
  assert.equal((await state()).catalog_update.available, false);
  const history = await fetch(base + "/api/alchemy/history").then((r) =>
    r.json(),
  );
  const backupId = history.events[0].result.previous_backup_id;
  assert.equal(
    (await fetch(base + "/api/alchemy/backup?id=" + backupId)).ok,
    true,
  );
  await change("inventory", {
    changes: data.items.map((i) => ({
      item_id: i.item_id,
      quantity: i.item_id === rage ? 0 : 10000,
    })),
  });
  await page.goto(base + "/alchemy/recipes/" + rage);
  await loaded();
  await page.locator("#goal-form [name=quantity]").fill("110");
  await page.getByRole("button", { name: "목표 등록", exact: true }).click();
  await stored();
  await page.locator("#batch-policy-form select").selectOption("surplus");
  await page.getByRole("button", { name: "배치 기준 저장" }).click();
  await stored();
  let plan = (await fetch(base + "/api/alchemy/plans").then((r) => r.json()))
    .plans[0];
  assert.deepEqual(
    plan.rows[0].batches.map((b) => b.planned_output),
    [100, 10],
  );
  assert.equal(await page.locator("#craft-shortages").count(), 0);
  await page
    .locator(
      `[data-tree="${rage}"] > .branch-slot > .tree-actions > button[data-start]`,
    )
    .first()
    .waitFor();
  assert.equal(
    await page
      .locator(
        `[data-tree="${rage}"] > .branch-slot > .tree-actions > button[data-start]`,
      )
      .count(),
    2,
  );
  await page
    .locator(
      `[data-tree="${rage}"] > .branch-slot > .tree-actions > button[data-start]`,
    )
    .first()
    .click();
  assert.equal(await page.locator("#start-recipe").inputValue(), rage + "-100");
  assert.equal(
    await page.locator("#start-form [name=calls]").inputValue(),
    "1",
  );
  await page.getByRole("button", { name: "재료 차감하고 제작 시작" }).click();
  await stored();
  assert.equal((await state()).jobs[0].recipe.recipe_id, rage + "-100");
  assert.equal((await state()).goals[0].batch_policies[rage], "surplus");
  await page.getByRole("button", { name: "결과 입력", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "격노의 영약 실제 산출량", exact: true })
    .fill("100");
  await page.getByRole("button", { name: "실제 산출량으로 제작 완료" }).click();
  await stored();
  plan = (await fetch(base + "/api/alchemy/plans").then((r) => r.json()))
    .plans[0];
  assert.equal(plan.rows[0].batches[0].recipe_id, rage + "-10");
  assert.equal(plan.rows[0].batches[0].calls, 1);
  await page.screenshot({
    path: join(out, "mixed-batch-after-100.png"),
    fullPage: true,
  });
  const icon = data.items.find((i) => i.item_id === rage).icon;
  await page.route("**/alchemy/assets/" + icon, (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page.reload();
  await loaded();
  await page
    .locator(`img[data-item-id="${rage}"]`)
    .evaluateAll((imgs) => imgs.forEach((i) => (i.loading = "eager")));
  await page.waitForFunction(() =>
    [...document.querySelectorAll("img.image-unavailable")].some(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  assert.match(
    await page.locator("img.image-unavailable").first().getAttribute("title"),
    /이미지 확인 필요/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(out, "mobile-fallback.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
    "no page horizontal overflow",
  );
  assert.deepEqual(errors, []);
  assert.equal(
    requests.some((p) => p.startsWith("/assets/") || p === "/api/bootstrap"),
    false,
    "alchemy does not load barter resources",
  );
  const report = {
    ok: true,
    catalogConflictResolved: true,
    previousCatalogBackup: true,
    mixed110: true,
    actualRecipePreserved: true,
    actualOutputReplanned: true,
    fallback404: true,
    mobile: true,
    barterResourceIsolation: true,
    temporaryData: true,
  };
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output: out }));
} finally {
  await browser?.close();
  if (server.exitCode === null)
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
    });
}
