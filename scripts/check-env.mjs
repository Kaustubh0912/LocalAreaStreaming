import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const files = [path.join(root, ".env"), path.join(root, "server", ".env")];

const parseEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf8");
  const entries = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    const value = line
      .slice(equalsIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    entries[key] = value;
  }

  return entries;
};

const looksLikePath = (value) =>
  /\.env(\.example)?$/i.test(value) ||
  /^[A-Z]:\\/i.test(value) ||
  value.startsWith("/") ||
  value.startsWith("./");

const describeApiKey = (value) => {
  if (value === undefined) return "missing";
  if (value === "") return "empty";
  if (looksLikePath(value)) return "looks like a file path, not an API key";
  if (value.length < 20) return `present but short (${value.length} chars)`;
  return `present (${value.length} chars)`;
};

const describePath = (value) => {
  if (value === undefined) return "missing";
  if (value === "") return "empty";
  return `present (${value})`;
};

for (const file of files) {
  const relativePath = path.relative(root, file) || ".env";
  const entries = parseEnvFile(file);

  if (!entries) {
    console.log(`${relativePath}: missing`);
    continue;
  }

  console.log(`${relativePath}: found`);
  console.log(`  TMDB_API_KEY: ${describeApiKey(entries.TMDB_API_KEY)}`);
  console.log(`  LAS_MEDIA_PATH: ${describePath(entries.LAS_MEDIA_PATH)}`);
  console.log(`  HW_ACCEL: ${entries.HW_ACCEL ?? "missing"}`);
  console.log(
    `  OPENSUBTITLES_API_KEY: ${describeApiKey(entries.OPENSUBTITLES_API_KEY)}`,
  );
}

console.log(
  `process.env.TMDB_API_KEY: ${describeApiKey(process.env.TMDB_API_KEY)}`,
);
