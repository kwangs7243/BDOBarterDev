import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The R005 review fixture owns the isolated fake runtime and temporary DB. Its
// completion path now also exercises R006 response-loss replay, retained UI job,
// identical mutation bytes, crop follow-up, and the no-session-write boundary.
const target = fileURLToPath(new URL("./browser_trade_review.mjs", import.meta.url));
const child = spawn(process.execPath, [target], { stdio: "inherit", windowsHide: true, env: process.env });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
});
if (exitCode !== 0) process.exitCode = exitCode;
else console.log("browser_trade_review_persistence: PASS · isolated DB, response-loss replay, crop save, no session write");
