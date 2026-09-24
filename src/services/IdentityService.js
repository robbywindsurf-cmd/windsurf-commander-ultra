// IdentityService.js — nickname+password identity, ported from
// windsurf-native's src/identityGate.js so this app can authenticate
// against Oracle's already-working reference-key system (and, soon, sync
// session data up) without waiting on Apple Sign-In — that's blocked on
// an Apple Developer account; this needs no native module and no Apple
// approval at all.
//
// Deterministic: the same nickname+password always derives the same
// SHA-256 key on any device (see src/utils/sha256.js — pure JS, not
// expo-crypto, so this works via a normal Metro/JS reload with no native
// rebuild). registerIdentity()/loginIdentity() call the exact same
// windsurf-register/windsurf-login n8n workflows windsurf-native uses, so
// an account created on one app works on the other — same
// users.reference_key_hash row either way.
import { UserStore } from '@commandersuite/core';
import { sha256Hex } from '../utils/sha256';

const BASE = 'https://windsurf.surfkat.co.uk';

function deriveReferenceKey(nickname, password) {
  const normalizedNickname = nickname.trim().toLowerCase();
  return sha256Hex(`${normalizedNickname}:${password}`);
}

// Mirrors identityGate.js's own fetch patch — every request to BASE
// carries X-Reference-Key once logged in, so SyncService (and anything
// else added later) doesn't need to attach it manually per-call.
let currentReferenceKey = null;
let patched = false;

function patchFetch() {
  if (patched) return;
  patched = true;
  const originalFetch = global.fetch;
  global.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (currentReferenceKey && url && url.startsWith(BASE)) {
      init = {
        ...init,
        headers: {
          ...(init.headers || {}),
          'X-Reference-Key': currentReferenceKey,
        },
      };
    }
    return originalFetch(input, init);
  };
}

export const IdentityService = {
  // Call once at app startup (App.js), alongside SiteAuthService.init() —
  // loads any saved reference key and patches fetch immediately.
  async init() {
    patchFetch();
    const user = await UserStore.getUser();
    if (user?.reference_key) currentReferenceKey = user.reference_key;
    return IdentityService.getCurrentIdentity();
  },

  // { referenceKey, oracleUserId, nickname } | null
  async getCurrentIdentity() {
    const user = await UserStore.getUser();
    if (!user?.reference_key || !user?.oracle_user_id) return null;
    return { referenceKey: user.reference_key, oracleUserId: user.oracle_user_id, nickname: user.nickname };
  },

  // New account. Fails with a clear error if the nickname is already
  // taken (windsurf-register's own uniqueness check on users.nickname).
  async register(nickname, password, consentLevel = 2) {
    const trimmedNickname = nickname.trim();
    if (!trimmedNickname) throw new Error('Nickname is required.');
    if (!password) throw new Error('Password is required.');

    const referenceKey = deriveReferenceKey(trimmedNickname, password);

    const res = await fetch(`${BASE}/webhook/windsurf-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference_key: referenceKey,
        nickname: trimmedNickname,
        consent_level: consentLevel,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Registration failed (${res.status})`);
    }

    const data = await res.json();
    await UserStore.saveIdentitySession({
      referenceKey,
      oracleUserId: data.user_id,
      nickname: data.nickname || trimmedNickname,
    });
    currentReferenceKey = referenceKey;
    patchFetch();
    return IdentityService.getCurrentIdentity();
  },

  // Returning to an existing account, possibly on this device for the
  // first time — derives the same key the original registration would
  // have produced and asks Oracle to confirm it matches a real user.
  async login(nickname, password) {
    const trimmedNickname = nickname.trim();
    if (!trimmedNickname) throw new Error('Nickname is required.');
    if (!password) throw new Error('Password is required.');

    const referenceKey = deriveReferenceKey(trimmedNickname, password);

    const res = await fetch(`${BASE}/webhook/windsurf-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_key: referenceKey }),
    });

    if (!res.ok) {
      throw new Error('Incorrect nickname or password.');
    }

    const data = await res.json();
    if (!data.authenticated) {
      throw new Error(data.error || 'Incorrect nickname or password.');
    }

    await UserStore.saveIdentitySession({
      referenceKey,
      oracleUserId: data.user_id,
      nickname: data.nickname || trimmedNickname,
    });
    currentReferenceKey = referenceKey;
    patchFetch();
    return IdentityService.getCurrentIdentity();
  },

  async logout() {
    await UserStore.clearIdentitySession();
    currentReferenceKey = null;
  },
};
