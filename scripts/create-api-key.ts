import { createApiKey, hashApiKey, randomId } from "@eliteconverter/shared";

const args = new Map(
  process.argv.slice(2).flatMap((item, index, all) => {
    if (!item.startsWith("--")) return [];
    return [
      [item.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : "true"],
    ];
  }),
);

const name = args.get("name") ?? "local-test";
const ownerId = args.get("owner") ?? "usr_local";
const environment = args.get("live") === "true" ? "live" : "test";
const secret = process.env.API_KEY_HASH_SECRET ?? "dev-only-replace-before-production";
const rawKey = createApiKey(environment);
const keyHash = await hashApiKey(rawKey, secret);
const keyId = randomId("key", 20);
const now = new Date().toISOString();

console.log("Raw API key. Store it now; it is not recoverable:");
console.log(rawKey);
console.log("");
console.log("SQL seed statement for D1:");
console.log(
  `INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES ('${ownerId}', 'Local Operator', '${now}', '${now}');`,
);
console.log(
  `INSERT INTO api_keys (id, owner_id, name, prefix, key_hash, status, scopes, created_at) VALUES ('${keyId}', '${ownerId}', '${name}', '${rawKey.slice(
    0,
    12,
  )}', '${keyHash}', 'active', '["conversions:create","conversions:read","conversions:cancel"]', '${now}');`,
);
