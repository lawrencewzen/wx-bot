// Build single-file executables: dist/wx-bot_<os>_<arch> (+ musl builds for Alpine).
// Usage: bun run scripts/cross.ts [version]
import { $ } from "bun";

const version = process.argv[2] ?? (await $`git describe --tags --always --dirty`.nothrow().text()).trim() ?? "dev";
const targets: [string, string][] = [
  ["bun-linux-x64", "wx-bot_linux_amd64"],
  ["bun-linux-arm64", "wx-bot_linux_arm64"],
  ["bun-darwin-x64", "wx-bot_darwin_amd64"],
  ["bun-darwin-arm64", "wx-bot_darwin_arm64"],
  ["bun-linux-x64-musl", "wx-bot_linux_amd64_musl"],
  ["bun-linux-arm64-musl", "wx-bot_linux_arm64_musl"],
];
const only = process.env.TARGETS?.split(",");
for (const [target, out] of targets) {
  if (only && !only.includes(out)) continue;
  await $`bun build src/main.ts --compile --minify --target=${target} --define WXBOT_VERSION=${JSON.stringify(version)} --outfile ../../dist/${out}`;
}
