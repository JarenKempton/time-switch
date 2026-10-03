import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TABLES = ["companies", "devices", "sessions", "hour_retrievals"];
const USAGE =
  "usage: node scripts/d1-migrate.mjs <import|verify> <export.json> <database> (--local|--remote) [wrangler flags]";
const wrangler = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/.bin/wrangler",
);

const [command, exportPath, database, ...wranglerFlags] = process.argv.slice(2);
if (!["import", "verify"].includes(command) || !exportPath || !database)
  fail(USAGE);
if (wranglerFlags.includes("--local") === wranglerFlags.includes("--remote"))
  fail(`Pass exactly one of --local or --remote.\n${USAGE}`);

const tables = readTables(exportPath);
if (command === "import") importTables(tables);
else verifyTables(tables);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readTables(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const exported = (parsed.data ?? parsed).tables;
  const names = Object.keys(exported ?? {}).sort();
  if (names.join() !== [...TABLES].sort().join())
    fail(`Export tables [${names}] do not match expected [${TABLES}].`);
  return exported;
}

function d1(args) {
  return execFileSync(
    wrangler,
    ["d1", "execute", database, ...args, ...wranglerFlags],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
}

function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isInteger(value))
    return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Unsupported value ${JSON.stringify(value)}`);
}

function upsert(table, row) {
  const columns = Object.keys(row);
  const quoted = columns.map((column) => `"${column}"`);
  const updates = quoted
    .filter((column) => column !== '"id"')
    .map((column) => `${column} = excluded.${column}`);
  return `INSERT INTO "${table}" (${quoted.join(", ")}) VALUES (${columns
    .map((column) => literal(row[column]))
    .join(", ")}) ON CONFLICT ("id") DO UPDATE SET ${updates.join(", ")};`;
}

function importTables(exported) {
  const statements = TABLES.flatMap((table) =>
    exported[table].map((row) => upsert(table, row)),
  );
  const file = join(mkdtempSync(join(tmpdir(), "d1-import-")), "import.sql");
  writeFileSync(file, `${statements.join("\n")}\n`);
  d1([`--file=${file}`, "--yes"]);
  console.log(`Upserted ${statements.length} rows into ${database}.`);
  for (const table of TABLES)
    console.log(`  ${table}: ${exported[table].length}`);
}

function digest(rows) {
  const canonical = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) =>
      JSON.stringify(
        Object.keys(row)
          .sort()
          .map((key) => [key, row[key]]),
      ),
    );
  return createHash("sha256")
    .update(canonical.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function companyTotals(sessions, retrievals) {
  const totals = new Map();
  const entry = (id) => {
    if (!totals.has(id))
      totals.set(id, { sessionSeconds: 0, retrievalSeconds: 0 });
    return totals.get(id);
  };
  for (const session of sessions)
    if (session.ended_at !== null)
      entry(session.company_id).sessionSeconds +=
        session.ended_at - session.started_at;
  for (const retrieval of retrievals)
    entry(retrieval.company_id).retrievalSeconds += retrieval.total_seconds;
  for (const total of totals.values()) total.sessionSeconds /= 1000;
  return totals;
}

function verifyTables(exported) {
  const output = d1([
    "--json",
    `--command=${TABLES.map((table) => `SELECT * FROM "${table}"`).join("; ")}`,
  ]);
  const results = JSON.parse(output).map((result) => result.results);
  const target = Object.fromEntries(
    TABLES.map((table, index) => [table, results[index]]),
  );

  const checks = TABLES.flatMap((table) => [
    [`${table} rows`, exported[table].length, target[table].length],
    [`${table} digest`, digest(exported[table]), digest(target[table])],
  ]);
  const expected = companyTotals(exported.sessions, exported.hour_retrievals);
  const actual = companyTotals(target.sessions, target.hour_retrievals);
  const names = new Map(exported.companies.map((row) => [row.id, row.name]));
  for (const id of new Set([...expected.keys(), ...actual.keys()])) {
    const label = names.get(id) ?? id;
    for (const key of ["sessionSeconds", "retrievalSeconds"])
      checks.push([
        `${label} ${key}`,
        expected.get(id)?.[key] ?? 0,
        actual.get(id)?.[key] ?? 0,
      ]);
  }

  const rows = checks.map(([check, source, d1Value]) => ({
    check,
    export: source,
    d1: d1Value,
    match: source === d1Value ? "ok" : "MISMATCH",
  }));
  console.table(rows);
  const mismatches = rows.filter((row) => row.match !== "ok");
  if (mismatches.length)
    fail(
      `VERIFY FAILED: ${mismatches.length} mismatch(es): ${mismatches.map((row) => row.check).join(", ")}`,
    );
  console.log(`VERIFY OK: ${rows.length} checks match.`);
}
