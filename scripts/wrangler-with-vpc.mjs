import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID || process.env.NATIVE_EGRESS_TUNNEL_ID;
const args = process.argv.slice(2);
const isDeploy = args[0] === "deploy" && !args.includes("--dry-run");

if (tunnelId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tunnelId)) {
  console.error("CLOUDFLARE_TUNNEL_ID must be a valid Cloudflare Tunnel/VPC UUID.");
  process.exit(1);
}

if (isDeploy && !tunnelId) {
  console.error("Set CLOUDFLARE_TUNNEL_ID to your Cloudflare Tunnel/VPC egress ID before deploying.");
  console.error("Example: CLOUDFLARE_TUNNEL_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx npm run deploy");
  process.exit(1);
}

let wranglerArgs = args;
if (tunnelId) {
  const sourcePath = resolve("wrangler.jsonc");
  const generatedPath = resolve(".wrangler", "generated-wrangler.jsonc");
  const source = await readFile(sourcePath, "utf8");
  const generated = source.replace(
    '  "migrations": [\n    { "tag": "v1", "new_sqlite_classes": ["AccountPool"] },\n    { "tag": "v2", "new_sqlite_classes": ["ProxyExecutor"] }\n  ],',
    `  "migrations": [\n    { "tag": "v1", "new_sqlite_classes": ["AccountPool"] },\n    { "tag": "v2", "new_sqlite_classes": ["ProxyExecutor"] }\n  ],\n  "vpc_networks": [\n    {\n      "binding": "NATIVE_EGRESS",\n      "tunnel_id": "${tunnelId}",\n      "remote": true\n    }\n  ],`,
  ).replace('"main": "src/index.ts"', '"main": "../src/index.ts"');

  if (generated === source) {
    console.error("Could not inject NATIVE_EGRESS VPC binding into wrangler.jsonc.");
    process.exit(1);
  }

  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, generated);
  wranglerArgs = ["--config", generatedPath, ...args];
}

const child = spawn("wrangler", wranglerArgs, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
