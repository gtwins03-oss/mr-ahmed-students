/**
 * Handing a URL to something that is not this app.
 *
 * There are two jobs here and they are NOT interchangeable. Treating them as
 * one is exactly why «فتح واتساب» appeared to do nothing inside the APK:
 *
 *  1. `openExternal(url)` — an ordinary web page (green-api.com, docs…). In a
 *     browser tab that is `window.open`. In the APK it is `Browser.open`, i.e.
 *     an **in-app Chrome Custom Tab**: the page renders over our activity and
 *     the back gesture returns to the app. For a web page that is correct.
 *
 *  2. `openWhatsapp({ appLink, webLink })` — a chat that has to land in the
 *     WhatsApp *app*. `Browser.open` cannot do that, whatever the comment that
 *     used to sit here claimed. Read the plugin's Android source: it builds a
 *     `CustomTabsIntent` and calls `launchUrl`, so a `https://wa.me/…` URL is
 *     loaded by Chrome inside our own task and the teacher lands on WhatsApp's
 *     *web landing page*, still inside our app. It never hands anything to the
 *     OS, and no manifest entry changes that.
 *
 *     The handoff that does work is the custom scheme
 *     `whatsapp://send?phone=…&text=…`. Capacitor routes every non-http(s)
 *     navigation through `Bridge.launchIntent`, which fires an
 *     `Intent.ACTION_VIEW` at Android, and Android opens WhatsApp. The React UI
 *     is untouched underneath — the WebView never navigates.
 *
 * That intent still depends on the <queries> block in AndroidManifest.xml
 * declaring com.whatsapp / com.whatsapp.w4b: from Android 11 an undeclared
 * package is invisible, `startActivity` throws ActivityNotFoundException, and
 * Capacitor **swallows** the exception. No crash, no error, no WhatsApp. Same
 * silence when WhatsApp simply is not installed — which is why the native path
 * below arms a timer instead of trusting the navigation.
 */

import { Browser } from "@capacitor/browser";

import { isNativeApp } from "./apiBase";

/**
 * How long WhatsApp gets to pull us into the background before we conclude that
 * nothing claimed the scheme. Long enough for a cold start on a slow phone,
 * short enough that the fallback still reads as a response to the tap.
 */
const APP_HANDOFF_MS = 900;

export interface WhatsappLinks {
  /** `whatsapp://send?phone=…&text=…` — the scheme that reaches the app. */
  appLink: string;
  /** `https://wa.me/…` — the browser path, and the native last resort. */
  webLink: string;
}

/**
 * Opens an ordinary web link. Never a WhatsApp chat — use `openWhatsapp` for
 * those, and see the note above for why the difference matters.
 *
 * Browser behaviour is deliberately byte-for-byte what it was before this
 * helper existed — `window.open(url, "_blank")`, no `noopener`, result
 * ignored — so popup-blocker handling and the warning banner on the send
 * queue keep their existing meaning.
 *
 * The `window.open` call sits before every `await` on purpose: an async
 * function runs synchronously up to its first suspension, which keeps the call
 * inside the click's user-gesture window. Move it after an `await` and every
 * browser will start blocking the popup.
 */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;

  if (!isNativeApp()) {
    window.open(url, "_blank");
    return;
  }

  try {
    await Browser.open({ url });
  } catch {
    /* No handler, or the plugin is unavailable in this shell. A direct open is
       worse than a Custom Tab but still better than a dead button. */
    window.open(url, "_blank");
  }
}

/**
 * Watches a `whatsapp://` navigation and rescues it if it went nowhere.
 *
 * A handoff that worked pushes our activity to the background, which the
 * WebView reports as `visibilitychange` (or `pagehide`, if the system tears the
 * page down instead). Either event means WhatsApp took over, so the timer is
 * disarmed — firing the fallback behind an open WhatsApp would stack a Custom
 * Tab under it and confuse the back gesture.
 *
 * Still visible when the timer fires means nobody answered the intent: WhatsApp
 * is not installed, or the manifest hides it. The wa.me page in a Custom Tab is
 * then the honest outcome — it at least tells the teacher something happened.
 */
function armHandoffFallback(webLink: string): void {
  let timer = 0;

  const disarm = () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", disarm);
    window.removeEventListener("pagehide", disarm);
  };

  timer = window.setTimeout(() => {
    disarm();
    if (document.visibilityState !== "visible") return;
    void openExternal(webLink);
  }, APP_HANDOFF_MS);

  document.addEventListener("visibilitychange", disarm);
  window.addEventListener("pagehide", disarm);
}

/**
 * Opens a WhatsApp chat with the message already typed.
 *
 * Resolves as soon as the handoff has been *attempted*, not when WhatsApp
 * finishes: «إرسال الكل» walks the queue on its own cadence and must not
 * inherit this helper's timeout per message. The fallback timer keeps running
 * on its own afterwards.
 */
export async function openWhatsapp({ appLink, webLink }: WhatsappLinks): Promise<void> {
  if (!isNativeApp()) {
    // Before any `await` — see the user-gesture note on openExternal.
    if (webLink) window.open(webLink, "_blank");
    return;
  }

  // No scheme link (an old cached row from before the server sent one): the
  // Custom Tab is all that is left.
  if (!appLink) {
    await openExternal(webLink);
    return;
  }

  // Assigning `location.href` is what triggers `shouldOverrideUrlLoading`; the
  // WebView itself never follows a `whatsapp://` URL, so our page stays put.
  window.location.href = appLink;
  if (webLink) armHandoffFallback(webLink);
}
