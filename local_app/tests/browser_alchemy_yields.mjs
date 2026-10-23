import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  temp = await mkdtemp(join(tmpdir(), "bdo-yield-browser-"));
const base = "http://127.0.0.1:18696";
const out = process.env.BDO_YIELD_REPORT_DIR ?? join(temp, "report");
await mkdir(out, { recursive: true });
assert.equal(
  await fetch(base + "/suite-health")
    .then(() => true)
    .catch(() => false),
  false,
);
const launch = () =>
  spawn(
    process.env.PYTHON ?? "python",
    [
      "-B",
      "-c",
      `from local_app.backend.app import create_app;create_app(r'${join(temp, "barter.sqlite3")}',testing=True).run(host='127.0.0.1',port=18696,use_reloader=False)`,
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, LOCALAPPDATA: temp, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
let server = launch(),
  browser;
const read = (path) =>
  fetch(base + "/api/alchemy/" + path).then((r) => r.json());
async function change(action, fields) {
  const s = await read("state");
  const r = await fetch(base + "/api/alchemy/mutations/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({
      mutationId: crypto.randomUUID(),
      baseRevision: s.revision,
      ...fields,
    }),
  });
  const data = await r.json();
  assert.equal(r.ok, true, JSON.stringify(data));
  return data;
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(base + "/suite-health")
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    assert.equal(server.exitCode, null);
    await delay(100);
  }
  throw Error("server timeout");
}
try {
  await ready();
  const data = await read("catalog?full=1"),
    ids = Object.fromEntries(data.items.map((v) => [v.name, v.item_id]));
  const target = ids["맑은 액체 시약"];
  await change("inventory", {
    changes: [
      { item_id: target, quantity: 0 },
      ...["소금", "여명초", "정제수", "야생 들풀"].map((n) => ({
        item_id: ids[n],
        quantity: 30,
      })),
    ],
  });
  const g = (
    await change("goal", { item_id: target, quantity: 30, mode: "held" })
  ).goal;
  const url = base + "/alchemy/recipes/" + target + "?goal=" + g.goal_id;
  browser = await chromium.launch({
    executablePath:
      process.env.BDO_CHROME ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const loaded = () =>
    page.waitForFunction(
      () =>
        document.querySelector("#content")?.getAttribute("aria-busy") ===
        "false",
    );
  const saved = () =>
    page.waitForFunction(
      () => document.querySelector("#status")?.dataset.kind === "success",
    );
  await page.goto(url);
  await loaded();
  const row = () => page.locator(`[data-shortage="${target}"]`);
  assert.match(await row().innerText(), /기록 없음/);
  await row().getByRole("button", { name: "횟수 입력", exact: true }).click();
  assert.equal(await page.locator("#start-form [name=calls]").inputValue(), "");
  await page.locator("#start-form [name=calls]").fill("10");
  await page.getByRole("button", { name: "재료 차감하고 제작 시작" }).click();
  await saved();
  await page.getByRole("button", { name: "결과 입력", exact: true }).click();
  await page
    .getByRole("spinbutton", {
      name: "맑은 액체 시약 실제 산출량",
      exact: true,
    })
    .fill("25");
  await page.getByRole("button", { name: "실제 산출량으로 제작 완료" }).click();
  await saved();
  assert.match(await row().innerText(), /기록 평균 2.5개/);
  assert.match(await row().innerText(), /누적 10회/);
  assert.match(await row().innerText(), /계획상 2회/);
  const p = (await read("plans")).plans[0];
  assert.equal(p.rows[0].calls, 2);
  assert.equal(p.rows.find((v) => v.item_id === ids["소금"]).need, 2);
  await row().getByRole("button", { name: "횟수 입력", exact: true }).click();
  assert.equal(
    await page.locator("#start-form [name=calls]").inputValue(),
    "2",
  );
  await page.getByRole("button", { name: "재료 차감하고 제작 시작" }).click();
  await saved();
  await page.getByRole("button", { name: "결과 입력", exact: true }).click();
  await page
    .getByRole("spinbutton", {
      name: "맑은 액체 시약 실제 산출량",
      exact: true,
    })
    .fill("4");
  await page.getByRole("button", { name: "실제 산출량으로 제작 완료" }).click();
  await saved();
  const completed = await read("state");
  let stat = Object.values(completed.yield_statistics).find(
    (v) => v.total_calls === 12,
  );
  assert.equal(stat.total_output, 29);
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
  });
  server = launch();
  await ready();
  await page.reload();
  await loaded();
  assert.match(await row().innerText(), /누적 12회/);
  await page.screenshot({
    path: join(out, "learned-yield.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  const report = {
    ok: true,
    visibleShortages: true,
    noUnrecordedAutoCalls: true,
    actualResultLearned: true,
    weightedCalls: 12,
    weightedOutput: 29,
    nestedMaterialsRecomputed: true,
    restartPersistence: true,
    mobile: true,
  };
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (server.exitCode === null)
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
    });
}
