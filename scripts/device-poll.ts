/**
 * Device-flow 轮询 — 等待用户浏览器授权, token 落 .device-token (不回显)
 */
import * as fs from "fs";
import * as path from "path";

const dir = path.resolve(import.meta.dirname, "..");
const { device_code: deviceCode, interval = 5 } = JSON.parse(fs.readFileSync(path.join(dir, ".device-flow.json"), "utf-8"));
const CLIENT_ID = "178c6fc778ccc68e1d6a";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll() {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const j: any = await r.json();
      if (j.access_token) {
        fs.writeFileSync(path.join(dir, ".device-token"), j.access_token, "utf-8");
        console.log("TOKEN_OK scope:", j.scope ?? "?");
        return;
      }
      if (j.error === "authorization_pending") { await sleep(interval * 1000); continue; }
      if (j.error === "slow_down") { await sleep((interval + 5) * 1000); continue; }
      console.log("FLOW_ERROR:", j.error, j.error_description ?? "");
      process.exit(1);
    } catch (e) {
      console.log("net retry:", (e as Error).message.slice(0, 60));
      await sleep(8000);
    }
  }
  console.log("TIMEOUT");
  process.exit(1);
}
poll();
