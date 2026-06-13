import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const getDevCommand = () =>
  isWindows
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "npm run dev"] }
    : { command: "npm", args: ["run", "dev"] };

const services = [
  { name: "server", cwd: path.join(root, "server"), color: "\x1b[36m" },
  { name: "client", cwd: path.join(root, "client"), color: "\x1b[35m" },
];

const children = [];
let shuttingDown = false;

const prefix = (name, color, chunk) => {
  const reset = "\x1b[0m";
  const label = `${color}[${name}]${reset}`;

  chunk
    .toString()
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => console.log(`${label} ${line}`));
};

const stopAll = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.killed || child.pid === undefined) continue;

    if (isWindows) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(exitCode), 250);
};

for (const service of services) {
  const { command, args } = getDevCommand();
  const child = spawn(command, args, {
    cwd: service.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  children.push(child);

  child.stdout.on("data", (chunk) =>
    prefix(service.name, service.color, chunk),
  );
  child.stderr.on("data", (chunk) =>
    prefix(service.name, service.color, chunk),
  );

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    const failed = code && code !== 0;
    console.log(
      `[${service.name}] exited${signal ? ` via ${signal}` : ""}${code === null ? "" : ` with code ${code}`}`,
    );

    if (failed) stopAll(code);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
