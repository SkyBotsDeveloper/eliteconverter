import { randomId } from "@eliteconverter/shared";

const title = process.argv[2] ?? "Manual incident";
const message = process.argv[3] ?? "Incident details require operator update.";
const severity = process.argv[4] ?? "minor";
const now = new Date().toISOString();
const id = randomId("inc", 18);

console.log("Incident SQL:");
console.log(
  `INSERT INTO incidents (id, title, status, severity, message, created_at, updated_at) VALUES ('${id}', '${escapeSql(
    title,
  )}', 'investigating', '${escapeSql(severity)}', '${escapeSql(message)}', '${now}', '${now}');`,
);

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
