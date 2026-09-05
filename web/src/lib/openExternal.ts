/**
 * Opening a link that belongs to *another* app — in practice always a
 * `https://wa.me/…` URL from the send queue.
 *
 * In a desktop browser this is just `window.open`. Inside the Android APK it
 * cannot be: the WebView is the whole app, so a plain navigation would replace
 * the React UI with WhatsApp's web page and strand the teacher with no way
 * back. `@capacitor/browser` hands the URL to the system instead, which lets
 * Android route it to the installed WhatsApp app and keeps our activity alive
 * underneath.
 *
 * That routing only works because AndroidManifest.xml declares a <queries>
 * block for com.whatsapp / com.whatsapp.w4b. Without it Android 11+ hides
 * those packages, the URL falls back to a web page, and «فتح واتساب» looks
 * like it does nothing. If you are debugging "the button does nothing on my
 * phone", check the manifest before you touch this file.
 */

import { Browser } from "@capacitor/browser";

import { isNativeApp } from "./apiBase";

/**
 * Hands `url` to WhatsApp, the browser, or whatever else claims it.
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
       worse than a system intent but still better than a dead button. */
    window.open(url, "_blank");
  }
}
