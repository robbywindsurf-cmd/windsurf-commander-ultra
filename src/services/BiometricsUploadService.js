// BiometricsUploadService.js — pushes a rider's anonymised biometric
// category data up to Oracle (category_summaries' source — see
// BIOMECHANICS_FORCE_CALCULATOR_SPEC.md / commander-core's
// BiometricCategory.js). One-way, same direction as SyncService.js.
//
// No auth header is set here on purpose — same convention SyncService.js
// uses. SiteAuthService (site-wide Basic Auth) and IdentityService
// (X-Reference-Key) both patch global fetch once at app startup (App.js),
// attaching both headers automatically to any request whose URL starts
// with BASE. Setting a header manually here would duplicate that and
// could drift out of sync if the site password or reference key ever
// rotates. Requires both services to already be unlocked/logged in —
// same requirement as SyncService.
const BASE = 'https://windsurf.surfkat.co.uk';
const BIOMECHANICS_WEBHOOK = `${BASE}/webhook/windsurf-biomechanics`;

export async function uploadBiometrics(payload) {
  const res = await fetch(BIOMECHANICS_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON — treated as failure below */ }

  if (!res.ok || !data) {
    throw new Error((data && (data.error || data.errorMessage)) || text || `Biometrics upload failed (${res.status})`);
  }

  return data;
}

export const BiometricsUploadService = { uploadBiometrics };
