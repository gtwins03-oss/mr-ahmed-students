import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient singleton.
 *
 * `tsx watch` re-evaluates this module on every file change; without the
 * globalThis guard each reload would open a brand-new pool of SQLite
 * connections and eventually exhaust the file handles.
 */
type PrismaGlobal = typeof globalThis & { __tutorPrisma?: PrismaClient };

const globalForPrisma = globalThis as PrismaGlobal;

export const prisma: PrismaClient =
  globalForPrisma.__tutorPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__tutorPrisma = prisma;
}

/**
 * Absolute path to `server/data`.
 * Resolves identically from `server/src` (tsx dev) and `server/dist` (build).
 */
export const DATA_DIR = path.resolve(__dirname, "..", "data");

/** `mkdir -p server/data` — SQLite will not create a missing directory itself. */
export function ensureDataDir(): string {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  return DATA_DIR;
}

export default prisma;
