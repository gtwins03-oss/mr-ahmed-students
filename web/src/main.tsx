import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, onlineManager, type Mutation } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

import App from "./App";
import { AuthProvider } from "./lib/auth";
import { isRetryableError } from "./api/client";
import "./index.css";

/**
 * Query defaults tuned for the phone in a teacher's pocket, not a laptop on
 * localhost. The app is also wrapped as an Android APK and used on a weak but
 * present mobile connection, so the assumptions are:
 *
 *  - **Requests fail often and recover on their own.** Three retries with an
 *    exponential backoff capped at 10s. Only network faults and 5xx are
 *    retried (`isRetryableError`); a 400 or a 403 is an answer, not a hiccup.
 *  - **`networkMode: "offlineFirst"`.** Queries still run against the cache
 *    while offline, and mutations *pause* instead of failing, so tapping
 *    «غائب» in a basement classroom is not lost — it is replayed the moment
 *    the signal returns.
 *  - **`staleTime: 30s` with refetch on focus and on reconnect.** Long enough
 *    that flipping between pages costs nothing, short enough that data an
 *    assistant changed on another device shows up quickly. Realtime pushes
 *    (see `lib/socket.ts`) usually beat both.
 *
 * Full offline-first is explicitly out of scope: this survives a bad tunnel,
 * it is not a replacement for having a server.
 */

const MAX_RETRIES = 3;

/** 1s, 2s, 4s, 8s … never longer than 10s. */
const retryDelay = (attempt: number): number => Math.min(1_000 * 2 ** attempt, 10_000);

const retry = (failureCount: number, error: unknown): boolean =>
  failureCount < MAX_RETRIES && isRetryableError(error);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      retry,
      retryDelay,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      networkMode: "offlineFirst",
      retry,
      retryDelay,
    },
  },
});

/* ───────────────────────────── persistence ───────────────────────────── */

/**
 * The cache *and* the queue of paused mutations are written to localStorage,
 * so closing the app on the bus and reopening it at home neither loses the
 * teacher's edits nor shows an empty screen while the first request crawls in.
 *
 * Note for whoever adds a new mutation: react-query can only replay a
 * *restored* mutation if its function is registered with
 * `queryClient.setMutationDefaults([key], { mutationFn })`. Mutations without
 * a `mutationKey` survive the reload as pending rows but cannot be resumed —
 * anything critical enough to survive a restart needs a keyed default.
 */
const persister = createSyncStoragePersister({
  storage: safeStorage(),
  key: "tutor.query-cache",
  // Batches the writes; a 15-row attendance grid is one save, not fifteen.
  throttleTime: 1_000,
});

/** A WebView with storage disabled throws on access; persistence is optional. */
function safeStorage(): Storage | null {
  try {
    const probe = "__tutor_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24h

/* ─────────────────────────────── bootstrap ───────────────────────────── */

// index.html already declares these; re-assert them so the app is correct even
// if it is ever mounted into a host page that does not.
document.documentElement.lang = "ar";
document.documentElement.dir = "rtl";

// The moment the device is back online, flush whatever was queued while it was
// not. react-query does this itself on its own online signal; doing it here as
// well covers the WebView case where that signal arrives late or not at all.
const resumeQueuedWork = () => {
  void queryClient.resumePausedMutations();
};
window.addEventListener("online", resumeQueuedWork);
onlineManager.subscribe((isOnline) => {
  if (isOnline) resumeQueuedWork();
});

const container = document.getElementById("root");
if (!container) throw new Error('عنصر الجذر "#root" غير موجود في الصفحة');

createRoot(container).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: CACHE_MAX_AGE_MS,
        // Bump when a response shape changes, to drop caches from an old build.
        buster: "v1",
        dehydrateOptions: {
          // Only mutations waiting for the network are worth persisting;
          // finished ones would replay writes that already happened.
          shouldDehydrateMutation: (mutation: Mutation) => mutation.state.isPaused,
        },
      }}
      onSuccess={() => {
        // Restore finished: replay everything that was queued offline.
        void queryClient.resumePausedMutations();
      }}
    >
      {/* AuthProvider sits inside the router so it may navigate on logout,
          and inside the query provider so it may use the shared cache. */}
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
