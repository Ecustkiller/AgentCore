import { ApiError, NetworkError, tryRefresh } from "@/services/api";
import { fetchMe, mfaStatus } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";

/**
 * Resolve the live session into the auth store: who the caller is, whether the
 * console is open to them at all, and whether the MFA enrollment gate still stands.
 *
 * Single source for that triple. Anything that mints a *replacement* session (改密后
 * 后端换发 cookie) must re-derive it here instead of calling `setAuthenticated`
 * directly — that setter defaults `mfaSetupRequired` to false, which drops the gate
 * while the backend keeps 428-ing every request, with no route back to the wizard.
 */
export async function applySession(): Promise<void> {
  const { setAuthenticated, setForbidden } = useAuthStore.getState();
  const user = await fetchMe();
  if (user.role !== "admin") {
    setForbidden(user);
    return;
  }
  const { enrolled, required } = await mfaStatus();
  setAuthenticated(user, { mfaSetupRequired: required && !enrolled });
}

/** Cold-start probe: resolve the cookie session, falling back to a silent refresh. */
export async function bootstrap(): Promise<void> {
  const { setUnauthenticated, setUnavailable, setLoading } =
    useAuthStore.getState();
  setLoading();
  try {
    await applySession();
    return;
  } catch (err) {
    if (err instanceof NetworkError) {
      setUnavailable();
      return;
    }
    // Access cookie absent/expired. `/v1/auth/me` is an auth path so the HTTP
    // client will not auto-refresh; try a silent refresh (desktop parity) before
    // concluding the user is logged out.
    if (!(err instanceof ApiError) || err.status !== 401) {
      setUnauthenticated();
      return;
    }
  }

  try {
    if (!(await tryRefresh())) {
      setUnauthenticated();
      return;
    }
    await applySession();
  } catch (err) {
    if (err instanceof NetworkError) setUnavailable();
    else setUnauthenticated();
  }
}
