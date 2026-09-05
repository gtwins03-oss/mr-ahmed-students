/**
 * The auth entry point every other module imports.
 *
 * The implementation lives in `src/auth/AuthContext.tsx` — provider, hook and
 * the non-hook token helpers. This file exists so that `api/client.ts`,
 * `App.tsx`, `main.tsx` and the pages all reach it through one stable path,
 * and so that `client.ts` can pull in `getToken` / `clearToken` without
 * importing a `.tsx` module.
 *
 * The server *address* is a different concern and lives in `lib/apiBase.ts`.
 */

export {
  AuthProvider,
  useAuth,
  getToken,
  setToken,
  clearToken,
  TOKEN_KEY,
  USER_KEY,
} from "../auth/AuthContext";

export type { AuthValue } from "../auth/AuthContext";
