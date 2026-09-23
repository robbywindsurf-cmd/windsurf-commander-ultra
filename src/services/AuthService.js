// AuthService.js — Sign in with Apple, verified against windsurf-auth-service
// (Oracle) and stored locally via UserStore. This is the only place in the
// app that talks to the Oracle-hosted auth endpoint; everything else about
// account state reads back from the local SQLite user_profile row, exactly
// like the app's existing local-first data (no network needed to know
// "am I signed in").
//
// Signing in is optional — nothing else in the app is gated behind it yet.
// It exists now so a device has a real identity ready for whenever sync,
// leaderboards, etc. get built on top of it.
import * as AppleAuthentication from 'expo-apple-authentication';
import { UserStore } from '@commandersuite/core';

const AUTH_URL = 'https://windsurf.surfkat.co.uk/api/auth/apple';

export const AuthService = {
  async isAppleSignInAvailable() {
    return AppleAuthentication.isAvailableAsync();
  },

  // Returns the saved user_profile row (with account_id/account_email set)
  // on success. Throws with a message safe to show the user directly —
  // callers don't need to know whether it was cancelled, a network error,
  // or the server rejecting the token.
  async signInWithApple() {
    let credential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
    } catch (err) {
      // Apple's own SDK throws ERR_REQUEST_CANCELED when the user backs out
      // of the system sheet — not a real error, just "they changed their mind".
      if (err.code === 'ERR_REQUEST_CANCELED') return null;
      throw new Error('Apple Sign-In failed: ' + (err.message || 'unknown error'));
    }

    // fullName is only ever present on the very first sign-in for this app
    // (Apple's privacy design) — never sent again on subsequent logins, so
    // it's captured here or not at all.
    const displayName = credential.fullName
      ? [credential.fullName.givenName, credential.fullName.familyName].filter(Boolean).join(' ') || null
      : null;

    let res;
    try {
      res = await fetch(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: credential.identityToken, displayName }),
      });
    } catch (err) {
      throw new Error('Could not reach the sign-in server. Check your connection and try again.');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Sign-in server error (${res.status})`);
    }

    const { token, account } = await res.json();
    await UserStore.saveAuthSession({
      accountId: account.id,
      email: account.email,
      token,
      tier: account.tier,
    });
    return UserStore.getUser();
  },

  async signOut() {
    await UserStore.clearAuthSession();
  },

  // { accountId, accountEmail } | null — reads the local row only, no
  // network call, matching this app's existing local-first pattern.
  async getCurrentAccount() {
    const user = await UserStore.getUser();
    if (!user?.account_id) return null;
    return { accountId: user.account_id, email: user.account_email };
  },
};
