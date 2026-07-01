import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".wrangler",
  "playwright-report",
  "test-results",
]);
const findings: Array<{ file: string; pattern: string }> = [];

const patterns = [
  { name: "GitHub token", regex: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  {
    name: "Cloudflare token assignment",
    regex: /CLOUDFLARE_API_TOKEN\s*=\s*['"]?[A-Za-z0-9_-]{20,}/i,
  },
  { name: "EliteConverter raw API key", regex: /ec_(?:live|test)_[A-Za-z0-9]{30,}/ },
  { name: "Private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
];

async function walk(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (entry.isFile()) await scan(path);
  }
}

async function scan(path: string): Promise<void> {
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|lock)$/i.test(path)) return;
  const text = await readFile(path, "utf8");
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      findings.push({
        file: path.replace(`${root}\\`, "").replace(`${root}/`, ""),
        pattern: pattern.name,
      });
    }
  }
}

await walk(root);

if (findings.length) {
  console.error("Potential secrets found:");
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.pattern}`);
  process.exit(1);
}

console.log("No obvious committed secrets found.");
