// Disable SSR — the app is fully client-side (auth, data fetching all happen in onMount).
// Keep rendering deterministic and avoid server-side auth/data fetching in the Worker.
export const ssr = false;
