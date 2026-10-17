/** Public build-time settings (override with VITE_* variables). */
export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000',
  oidcAuthority: (import.meta.env.VITE_OIDC_AUTHORITY as string | undefined) ?? 'http://localhost:8080/realms/d4',
  oidcClientId: (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined) ?? 'd4-web',
};
