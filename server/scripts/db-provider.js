/**
 * db-provider.js — flip the Prisma datasource between SQLite and PostgreSQL.
 *
 *   node scripts/db-provider.js sqlite
 *   node scripts/db-provider.js postgresql
 *
 * Rewrites exactly ONE line of prisma/schema.prisma: the `provider = "..."`
 * inside the `datasource db { ... }` block. The generator's own `provider =
 * "prisma-client-js"` line is never touched, and no model is modified.
 *
 * This is a one-line switch — not a migration — because every model in the
 * schema is deliberately provider-agnostic: status columns are `String` with
 * the allowed values documented inline (SQLite has no native enums), there are
 * no scalar lists / arrays, and no Postgres-only types (Json, Citext, Xml,
 * PostGIS…). The same schema therefore validates and generates identically on
 * both engines; only DATABASE_URL has to change alongside it.
 *
 * Idempotent: re-running with the value already in place is a no-op that still
 * reports success. Unknown arguments are refused with a non-zero exit code.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ALLOWED = ["sqlite", "postgresql"];

/** Absolute path to server/prisma/schema.prisma, whatever the cwd. */
const SCHEMA_PATH = path.resolve(__dirname, "..", "prisma", "schema.prisma");

/** Example DATABASE_URL per provider — printed as a reminder after switching. */
const URL_HINT = {
  sqlite: 'DATABASE_URL="file:../data/tutor.db"',
  postgresql:
    'DATABASE_URL="postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres?sslmode=require"',
};

/**
 * Matches the `provider = "..."` line that lives inside `datasource <name> { }`.
 * Anchoring on `datasource` keeps the generator block safe.
 */
const DATASOURCE_PROVIDER =
  /(datasource\s+\w+\s*\{[\s\S]*?provider\s*=\s*")([^"]+)(")/;

function fail(message) {
  console.error("");
  console.error(`  ❌ ${message}`);
  console.error("");
  console.error(`  الاستخدام: node scripts/db-provider.js <${ALLOWED.join(" | ")}>`);
  console.error("");
  process.exit(1);
}

function main() {
  const requested = (process.argv[2] || "").trim().toLowerCase();

  if (!requested) fail("لم يتم تحديد مزوّد قاعدة البيانات.");
  if (!ALLOWED.includes(requested)) {
    fail(`مزوّد غير معروف: "${process.argv[2]}" — المسموح: ${ALLOWED.join(" | ")}`);
  }

  if (!fs.existsSync(SCHEMA_PATH)) fail(`لم يتم العثور على الملف: ${SCHEMA_PATH}`);

  const original = fs.readFileSync(SCHEMA_PATH, "utf8");
  const match = original.match(DATASOURCE_PROVIDER);

  if (!match) fail("تعذّر العثور على سطر provider داخل كتلة datasource.");

  const current = match[2];

  console.log("");
  console.log(`  📄 الملف:     ${SCHEMA_PATH}`);
  console.log(`  ⬅️  قبل:      provider = "${current}"`);

  if (current === requested) {
    console.log(`  ➡️  بعد:      provider = "${requested}"  (لا تغيير — المزوّد مضبوط بالفعل)`);
    console.log("");
    return;
  }

  const updated = original.replace(
    DATASOURCE_PROVIDER,
    (_full, head, _old, tail) => `${head}${requested}${tail}`
  );

  fs.writeFileSync(SCHEMA_PATH, updated, "utf8");

  console.log(`  ➡️  بعد:      provider = "${requested}"`);
  console.log("");
  console.log(`  ⚠️  لا تنسَ تحديث DATABASE_URL في ملف .env:`);
  console.log(`     ${URL_HINT[requested]}`);
  console.log("");
}

main();
