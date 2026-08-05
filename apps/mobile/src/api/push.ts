import {
  type DevicePlatform,
  registerDevice,
  unregisterDevice,
} from "@/api/devices";
// Native (Capacitor) push notification integration (原生推送, 前端技术与架构 §七).
//
// The backend already pushes a 需要你 notification when an agent durably pauses
// (runtime/suspension_persistence.py _notify_pause → push/notify.py notify_user), carrying
// deep-link data {conversation_id, message_id, kind}. This module is the missing client
// half: register the device's FCM token with /v1/devices, and on a notification tap
// deep-link to the paused conversation.
//
// Native-only — every entry no-ops on web (a browser has no FCM), mirroring secureStorage.ts:
// the plugin import is bundled but its native calls only run behind isNativePlatform(), so a
// web build never invokes it.
//
// CRITICAL (Android): PushNotifications.register() **native-crashes** the process when
// google-services.json is missing (FirebaseApp not initialized) — JS try/catch cannot catch
// that. Gate with VITE_PUSH_ENABLED=true only when the release build includes that file.
//
// M-04: logout ↔ late FCM 'registration' race — generation gate + last-token persistence so
// disablePush still DELETEs when currentToken is null, and a post-logout callback never POSTs
// the device back onto the signed-out user.
import { Capacitor } from "@capacitor/core";
import {
  type ActionPerformed,
  PushNotifications,
  type Token,
} from "@capacitor/push-notifications";

const LAST_TOKEN_KEY = "agentcore.push.lastToken";

/** FCM token last seen this process (may be cleared on disable / registrationError). */
let currentToken: string | null = null;
/**
 * Survives `currentToken = null` so logout can still DELETE when the OS token arrived earlier
 * (or was restored from disk) but was cleared from `currentToken` before disablePush ran.
 */
let lastToken: string | null = null;
/** True between enablePush and disablePush — late registration must not POST when false. */
let pushDesired = false;
/**
 * Bumped on enable / disable. In-flight registerDevice that finishes after logout compares
 * against this and compensates with unregister if the generation moved.
 */
let pushGeneration = 0;

function platform(): DevicePlatform {
  // Capacitor.getPlatform() returns ios | android | web — exactly the backend's closed set.
  return Capacitor.getPlatform() as DevicePlatform;
}

/** True only when the native build was shipped with Firebase (google-services.json). */
function pushNativeEnabled(): boolean {
  return import.meta.env.VITE_PUSH_ENABLED === "true";
}

function readPersistedToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePersistedToken(token: string | null): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    if (token) store.setItem(LAST_TOKEN_KEY, token);
    else store.removeItem(LAST_TOKEN_KEY);
  } catch {
    // Persistence is best-effort; in-memory lastToken still covers same-process races.
  }
}

function rememberToken(token: string): void {
  currentToken = token;
  lastToken = token;
  writePersistedToken(token);
}

function tokenForUnregister(): string | null {
  return currentToken ?? lastToken ?? readPersistedToken();
}

/**
 * Upsert the device for the current session generation. If logout raced ahead (or finished
 * mid-POST), compensate with DELETE so the token is not left on the signed-out user.
 */
async function registerIfStillDesired(
  token: string,
  generation: number,
): Promise<void> {
  if (!pushDesired || generation !== pushGeneration) return;
  try {
    await registerDevice(token, platform());
  } catch {
    // Best-effort: a failed upsert just means "no push this session", never a crash.
    return;
  }
  if (!pushDesired || generation !== pushGeneration) {
    try {
      await unregisterDevice(token);
    } catch {
      // Backend prunes stale tokens on next push.
    }
  }
}

/**
 * Wire the push listeners ONCE at startup (from <PushBridge/>, inside the router):
 *  - 'registration'                    → an FCM token arrived; remember it + upsert it to
 *                                        the current user only while push is desired.
 *  - 'registrationError'               → clear currentToken (keep lastToken for logout DELETE).
 *  - 'pushNotificationActionPerformed' → the user tapped a notification (incl. cold start);
 *                                        deep-link to its conversation.
 *
 * `onOpenConversation` is injected rather than importing the router, so navigation stays in
 * the React tree. Returns a cleanup that removes the listeners (a no-op on web / when push
 * is build-disabled).
 */
export async function initPush(
  onOpenConversation: (conversationId: string) => void,
): Promise<() => void> {
  if (!Capacitor.isNativePlatform() || !pushNativeEnabled()) return () => {};

  // Hydrate lastToken from a prior session so a logout before the next 'registration' can
  // still DELETE the previously registered device.
  if (!lastToken) {
    lastToken = readPersistedToken();
  }

  try {
    const registration = await PushNotifications.addListener(
      "registration",
      (token: Token) => {
        rememberToken(token.value);
        // Logged out (or never enabled) — remember for a future unregister, but do not POST.
        if (!pushDesired) return;
        const generation = pushGeneration;
        void registerIfStillDesired(token.value, generation);
      },
    );
    const registrationError = await PushNotifications.addListener(
      "registrationError",
      () => {
        currentToken = null;
      },
    );
    const action = await PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (event: ActionPerformed) => {
        const conversationId = event.notification.data?.conversation_id;
        if (typeof conversationId === "string" && conversationId) {
          onOpenConversation(conversationId);
        }
      },
    );

    return () => {
      void registration.remove();
      void registrationError.remove();
      void action.remove();
    };
  } catch {
    // Listener setup failed — degrade to "no push", never break startup.
    return () => {};
  }
}

/**
 * Request notification permission and register with FCM (the token then arrives via the
 * 'registration' listener). Call when authenticated (fresh login / restored session). No-op
 * on web, when push is build-disabled, or if the user declines permission — push degrades
 * to "off", never blocks the app.
 *
 * Do NOT call register() without google-services.json: Android will kill the process
 * (IllegalStateException: Default FirebaseApp is not initialized).
 */
export async function enablePush(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !pushNativeEnabled()) return;
  pushDesired = true;
  pushGeneration += 1;
  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return;
    await PushNotifications.register();
  } catch {
    // Permission / registration failure degrades to "no push", never breaks the session.
  }
}

/**
 * Unregister this device server-side on logout so a signed-out phone stops receiving the
 * previous user's notifications. Best-effort; MUST run BEFORE the bearer tokens are cleared
 * (the DELETE is authenticated).
 *
 * Uses lastToken / persisted token when `currentToken` is still null (FCM callback not yet
 * fired) so logout never empty-runs past a previously known device token.
 */
export async function disablePush(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !pushNativeEnabled()) return;
  // Invalidate any in-flight / late registration before reading the token.
  pushDesired = false;
  pushGeneration += 1;
  const token = tokenForUnregister();
  currentToken = null;
  if (!token) return;
  try {
    await unregisterDevice(token);
    lastToken = null;
    writePersistedToken(null);
  } catch {
    // Keep lastToken / disk copy so a later attempt can still DELETE.
  }
}
