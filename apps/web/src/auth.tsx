import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { config } from './config';

export const userManager = new UserManager({
  authority: config.oidcAuthority,
  client_id: config.oidcClientId,
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  response_type: 'code',
  scope: 'openid profile email',
  automaticSilentRenew: true,
  // Session storage: tokens do not outlive the browser tab.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

interface AuthState {
  user: User | null;
  ready: boolean;
  /** Where the user was going before the sign-in redirect (handled by the /callback route). */
  returnTo: string | null;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Holds the signed-in user; redirects to Keycloak when there is none (except on /callback). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const onLoaded = (u: User) => setUser(u);
    const onUnloaded = () => setUser(null);
    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);

    (async () => {
      if (window.location.pathname === '/callback') {
        const u = await userManager.signinRedirectCallback();
        // The router navigates there (history.replaceState alone would not update it).
        if (!cancelled) {
          setReturnTo(typeof u.state === 'string' && u.state.startsWith('/') && u.state !== '/callback' ? u.state : '/');
          setUser(u);
        }
      } else {
        const u = await userManager.getUser();
        if (!u || u.expired) {
          await userManager.signinRedirect({ state: window.location.pathname + window.location.search });
          return;
        }
        if (!cancelled) setUser(u);
      }
      if (!cancelled) setReady(true);
    })().catch((e) => {
      console.error('Sign-in failed', e);
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
    };
  }, []);

  const logout = () => userManager.signoutRedirect();
  return <AuthContext.Provider value={{ user, ready, returnTo, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
