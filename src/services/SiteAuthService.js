// SiteAuthService.js — the shared, site-wide Basic Auth nginx puts in
// front of every Oracle /webhook/ route, ported from windsurf-native's
// src/authGate.js. Not a per-account credential (that's IdentityService.js
// / AuthService.js) — this is a single app-wide gate everyone using either
// identity system also needs, since nginx checks it before a request ever
// reaches n8n.
//
// Patches global fetch once, at app startup (see initSiteAuth() called
// from App.js) — every request to BASE automatically carries the header
// from then on, regardless of which service made the call.
import { UserStore } from '@commandersuite/core';

const BASE = 'https://windsurf.surfkat.co.uk';

let currentToken = null;
let patched = false;

function patchFetch() {
  if (patched) return;
  patched = true;
  const originalFetch = global.fetch;
  global.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (currentToken && url && url.startsWith(BASE)) {
      init = {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Basic ${currentToken}`,
        },
      };
    }
    return originalFetch(input, init);
  };
}

function toBase64(str) {
  if (typeof global.btoa === 'function') return global.btoa(str);
  return Buffer.from(str, 'utf8').toString('base64');
}

export const SiteAuthService = {
  // Call once at app startup (App.js) — loads any saved token and patches
  // fetch immediately, before any other service's first request.
  async init() {
    patchFetch();
    currentToken = await UserStore.getSiteAuth();
    return !!currentToken;
  },

  isUnlocked() {
    return !!currentToken;
  },

  async unlock(username, password) {
    if (!username || !password) throw new Error('Username and password are both required.');
    const token = toBase64(`${username}:${password}`);
    await UserStore.saveSiteAuth(token);
    currentToken = token;
    patchFetch();
  },

  async lock() {
    await UserStore.clearSiteAuth();
    currentToken = null;
  },
};
