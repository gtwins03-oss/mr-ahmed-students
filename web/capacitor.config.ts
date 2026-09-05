import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wrapper for the Arabic RTL front-end.
 *
 * The APK is a WebView shell around the *built* `dist/` bundle: `npm run build`
 * produces it, `npx cap sync android` copies it into
 * `android/app/src/main/assets/public`, Gradle turns that into StudentApp.apk.
 * There is no bundled server — the app dials the teacher's PC over the LAN at
 * the address entered on «إعداد الخادم» (src/pages/ServerSetup.tsx).
 *
 * The version line is pinned to Capacitor 6 on purpose: it targets compileSdk
 * 34 and builds under JDK 17, which is exactly the toolchain in D:\android-tools.
 * Capacitor 7+ requires JDK 21 and android-35 — upgrade both together or the
 * Gradle build fails with an unhelpful "invalid source release" error.
 */
const config: CapacitorConfig = {
  appId: "com.mrahmed.students",
  appName: "إدارة الطلاب",
  webDir: "dist",

  android: {
    /**
     * The WebView is served over `https://localhost` while the API it calls is
     * a plain-HTTP LAN address, which counts as mixed content and would be
     * blocked without this. Same LAN-testing caveat as `server.cleartext`
     * below — see the note there.
     */
    allowMixedContent: true,
  },

  server: {
    /**
     * `https` rather than the `capacitor://` default so that localStorage and
     * the fetch/CORS behaviour inside the WebView match what the app sees in a
     * desktop browser. Everything in `src/lib/apiBase.ts` assumes a normal
     * https origin.
     */
    androidScheme: "https",

    /**
     * ⚠️ TEMPORARY — LAN/HTTP TESTING ONLY.
     *
     * The teacher runs `npm start` on a laptop and the phone talks to
     * http://192.168.1.x:4000 over the local wifi. Android 9+ blocks plain
     * HTTP by default, so cleartext is enabled to make that work at all.
     *
     * It is *narrowed* to private address ranges by the network security
     * config at android/app/src/main/res/xml/network_security_config.xml —
     * public hosts still require HTTPS even with this flag on.
     *
     * THE MOMENT THE SERVER IS REACHABLE OVER HTTPS (real certificate, or a
     * tunnel such as Cloudflare/ngrok): set this to `false`, drop
     * `android.allowMixedContent` above, and delete the cleartext exceptions
     * from network_security_config.xml. Nothing else in the app depends on it.
     */
    cleartext: true,
  },
};

export default config;
