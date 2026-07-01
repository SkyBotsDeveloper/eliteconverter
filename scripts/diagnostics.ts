const checks = [
  "Job counts by status: SELECT status, COUNT(*) FROM conversion_jobs GROUP BY status;",
  "Recent failures: SELECT public_id, public_error_code, updated_at FROM conversion_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20;",
  "Stuck jobs: SELECT public_id, status, updated_at FROM conversion_jobs WHERE status NOT IN ('completed','failed','cancelled','expired') ORDER BY updated_at ASC LIMIT 20;",
  "Provider success rate: SELECT provider_id, status, COUNT(*) FROM provider_attempts GROUP BY provider_id, status;",
  "Webhook failures: SELECT event_type, status, COUNT(*) FROM client_webhook_deliveries GROUP BY event_type, status;",
];

console.log("EliteConverter diagnostics queries:");
for (const check of checks) console.log(`- ${check}`);
