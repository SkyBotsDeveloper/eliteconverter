const now = new Date().toISOString();

console.log("Seed SQL for local D1:");
console.log(
  `INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES ('usr_local', 'Local Operator', '${now}', '${now}');`,
);
console.log(
  `INSERT OR IGNORE INTO incidents (id, title, status, severity, message, created_at, updated_at) VALUES ('inc_local_ok', 'No active incidents', 'resolved', 'informational', 'Local seed incident for status page testing.', '${now}', '${now}');`,
);
