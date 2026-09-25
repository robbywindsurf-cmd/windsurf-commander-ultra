import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { WeatherBackfillService } from '../services/WeatherBackfillService';
import { RameHeadWindService } from '../services/RameHeadWindService';
import { HrBackfillService } from '../services/HrBackfillService';
import { AnalysisRepository, EmbeddingService, TierService, canAccess, LocalAI, getDb, SummaryService, BLEService, TIERS, UserStore } from '@commandersuite/core';
import { colors } from '../theme';
import { formatLocalTime } from '../utils/videoUtc';
import { AuthService } from '../services/AuthService';
import { IdentityService } from '../services/IdentityService';
import { SiteAuthService } from '../services/SiteAuthService';
import { SyncService } from '../services/SyncService';
import { BackupService } from '../services/BackupService';

const DEEP = colors.deep;
const SKY = colors.accent;
const TEXT = colors.text;
const ACCENT = '#f0a500';
const SAFE = '#2a9d8f';
const DANGER = colors.danger;

// RED — nothing indexed yet. AMBER — indexing is running, or some sessions
// are indexed but not all (stale relative to the latest session). GREEN —
// fully indexed and up to date.
function indexStatusColor(indexing, indexStatus) {
  if (indexing) return ACCENT;
  if (!indexStatus || indexStatus.indexed === 0) return DANGER;
  if (indexStatus.indexed < indexStatus.total) return ACCENT;
  return SAFE;
}

export default function SettingsScreen({ navigation }) {
  const [missingWeatherCount, setMissingWeatherCount] = useState(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState({ completed: 0, total: 0 });
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfillError, setBackfillError] = useState('');

  useEffect(() => {
    WeatherBackfillService.countMissing().then(setMissingWeatherCount).catch(() => {});
  }, []);

  const [account, setAccount] = useState(undefined); // undefined = loading, null = signed out
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    AuthService.getCurrentAccount().then(setAccount).catch(() => setAccount(null));
    AuthService.isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  async function handleSignIn() {
    setSigningIn(true);
    setAuthError('');
    try {
      const user = await AuthService.signInWithApple();
      if (user) setAccount({ accountId: user.account_id, email: user.account_email });
    } catch (err) {
      setAuthError(err.message || 'Sign-in failed.');
    } finally {
      setSigningIn(false);
    }
  }

  function handleSignOut() {
    Alert.alert('Sign out?', 'This only signs you out on this device — nothing local is deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await AuthService.signOut();
          setAccount(null);
        },
      },
    ]);
  }

  // Site-wide Basic Auth nginx puts in front of every Oracle /webhook/
  // route — a prerequisite for both AuthService and IdentityService
  // actually reaching Oracle at all, not tied to either of them.
  const [siteUnlocked, setSiteUnlocked] = useState(undefined); // undefined = loading
  const [siteUsername, setSiteUsername] = useState('');
  const [sitePassword, setSitePassword] = useState('');
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState('');

  useEffect(() => {
    setSiteUnlocked(SiteAuthService.isUnlocked());
  }, []);

  async function handleSiteUnlock() {
    setSiteBusy(true);
    setSiteError('');
    try {
      await SiteAuthService.unlock(siteUsername, sitePassword);
      setSiteUnlocked(true);
      setSitePassword('');
    } catch (err) {
      setSiteError(err.message || 'Failed to save.');
    } finally {
      setSiteBusy(false);
    }
  }

  function handleSiteLock() {
    Alert.alert('Forget site password?', 'You\'ll need to enter it again to reach Oracle.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: async () => {
          await SiteAuthService.lock();
          setSiteUnlocked(false);
        },
      },
    ]);
  }

  // One-way session sync, phone -> Oracle — see SyncService.js. Needs
  // both the site password and the Oracle identity above; the button is
  // just disabled (not hidden) until both are ready, so it's obvious what
  // else is needed rather than the option silently not being there.
  const [unsyncedCount, setUnsyncedCount] = useState(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ completed: 0, total: 0 });
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState('');

  useEffect(() => {
    SyncService.countUnsynced().then(setUnsyncedCount).catch(() => {});
  }, []);

  async function runSync() {
    setSyncRunning(true);
    setSyncError('');
    setSyncResult(null);
    setSyncProgress({ completed: 0, total: 0 });
    try {
      const result = await SyncService.syncSessions((completed, total) => setSyncProgress({ completed, total }));
      setSyncResult(result);
      setUnsyncedCount(await SyncService.countUnsynced());
    } catch (e) {
      setSyncError(e.message || 'Sync failed');
    } finally {
      setSyncRunning(false);
    }
  }

  // Full local database backup/restore — a real safety net independent
  // of anything else (same-bundle-ID app updates already preserve data
  // on their own — see App.js) for the cases that aren't: human error, a
  // future bug, or deleting the app by mistake.
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState('');

  const [imuConnected, setImuConnected] = useState(false);
  const [imuBatteryPct, setImuBatteryPct] = useState(null);

  useEffect(() => {
    setImuConnected(BLEService.isConnected());
    setImuBatteryPct(BLEService.getBatteryLevel());
  }, []);

  // RIDER PROFILE — full 4-measurement biometric setup now lives in its
  // own screen (RiderProfileScreen.js, richer UI with measuring
  // instructions and the derived category code) — this just shows status
  // and links there. undefined = loading.
  const [biometricCategory, setBiometricCategory] = useState(undefined);

  useEffect(() => {
    UserStore.getBiometrics().then((b) => setBiometricCategory(b?.biometric_category ?? null)).catch(() => setBiometricCategory(null));
  }, []);

  async function handleExportBackup() {
    setBackupBusy(true);
    setBackupError('');
    try {
      await BackupService.exportBackup();
    } catch (err) {
      setBackupError(err.message || 'Export failed.');
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreBackup() {
    setBackupError('');
    try {
      const asset = await BackupService.pickBackupFile();
      if (!asset) return;

      Alert.alert(
        'Restore this backup?',
        'This replaces EVERYTHING currently in the app with the backup file — sessions, gear, weather, chat history, all of it. This cannot be undone. You must close and reopen the app afterward for it to take effect.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            style: 'destructive',
            onPress: async () => {
              setBackupBusy(true);
              try {
                await BackupService.restoreBackup(asset);
                Alert.alert('Restore complete', 'Please close the app fully (swipe up in the app switcher) and reopen it now.');
              } catch (err) {
                setBackupError(err.message || 'Restore failed.');
              } finally {
                setBackupBusy(false);
              }
            },
          },
        ]
      );
    } catch (err) {
      setBackupError(err.message || 'Something went wrong.');
    }
  }

  function handleResetSyncState() {
    Alert.alert(
      'Reset sync status?',
      'Marks every session as not-yet-synced again — use this if a previous sync run reported success but nothing actually landed on Oracle.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          onPress: async () => {
            await SyncService.resetSyncState();
            setSyncResult(null);
            setUnsyncedCount(await SyncService.countUnsynced());
          },
        },
      ]
    );
  }

  // Oracle nickname+password identity (windsurf-native's existing
  // register/login system) — independent of Apple Sign-In above, works
  // today with no Apple Developer account needed. This is what session
  // sync to Oracle will authenticate with.
  const [identity, setIdentity] = useState(undefined); // undefined = loading, null = signed out
  const [identityMode, setIdentityMode] = useState('login'); // 'login' | 'register'
  const [identityNickname, setIdentityNickname] = useState('');
  const [identityPassword, setIdentityPassword] = useState('');
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState('');

  useEffect(() => {
    IdentityService.getCurrentIdentity().then(setIdentity).catch(() => setIdentity(null));
  }, []);

  async function handleIdentitySubmit() {
    setIdentityBusy(true);
    setIdentityError('');
    try {
      const result = identityMode === 'register'
        ? await IdentityService.register(identityNickname, identityPassword)
        : await IdentityService.login(identityNickname, identityPassword);
      setIdentity(result);
      setIdentityPassword('');
    } catch (err) {
      setIdentityError(err.message || 'Something went wrong.');
    } finally {
      setIdentityBusy(false);
    }
  }

  function handleIdentityLogout() {
    Alert.alert('Log out of Oracle account?', 'This only signs you out on this device — nothing on Oracle is deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: async () => {
          await IdentityService.logout();
          setIdentity(null);
        },
      },
    ]);
  }

  const [missingGustCount, setMissingGustCount] = useState(null);
  const [gustBackfillRunning, setGustBackfillRunning] = useState(false);
  const [gustBackfillProgress, setGustBackfillProgress] = useState({ completed: 0, total: 0 });
  const [gustBackfillResult, setGustBackfillResult] = useState(null);
  const [gustBackfillError, setGustBackfillError] = useState('');

  useEffect(() => {
    WeatherBackfillService.countMissingGusts().then(setMissingGustCount).catch(() => {});
  }, []);

  async function runGustBackfill() {
    setGustBackfillRunning(true);
    setGustBackfillError('');
    setGustBackfillResult(null);
    setGustBackfillProgress({ completed: 0, total: 0 });
    try {
      const result = await WeatherBackfillService.backfillMissingGusts((completed, total) =>
        setGustBackfillProgress({ completed, total })
      );
      setGustBackfillResult(result);
      setMissingGustCount(await WeatherBackfillService.countMissingGusts());
    } catch (e) {
      setGustBackfillError(e.message || 'Gust backfill failed');
    } finally {
      setGustBackfillRunning(false);
    }
  }

  const [rameEligibleCount, setRameEligibleCount] = useState(null);
  const [rameRunning, setRameRunning] = useState(false);
  const [rameProgress, setRameProgress] = useState({ completed: 0, total: 0 });
  const [rameResult, setRameResult] = useState(null);
  const [rameError, setRameError] = useState('');

  useEffect(() => {
    RameHeadWindService.getEligibleSessions().then((s) => setRameEligibleCount(s.length)).catch(() => {});
  }, []);

  async function runRameHeadBackfill() {
    setRameRunning(true);
    setRameError('');
    setRameResult(null);
    setRameProgress({ completed: 0, total: 0 });
    try {
      const result = await RameHeadWindService.backfillAll((completed, total) => setRameProgress({ completed, total }));
      setRameResult(result);
    } catch (e) {
      setRameError(e.message || 'Rame Head backfill failed');
    } finally {
      setRameRunning(false);
    }
  }

  async function runWeatherBackfill() {
    setBackfillRunning(true);
    setBackfillError('');
    setBackfillResult(null);
    setBackfillProgress({ completed: 0, total: 0 });
    try {
      const result = await WeatherBackfillService.backfillAllSessions((completed, total) =>
        setBackfillProgress({ completed, total })
      );
      setBackfillResult(result);
      setMissingWeatherCount(await WeatherBackfillService.countMissing());
    } catch (e) {
      setBackfillError(e.message || 'Backfill failed');
    } finally {
      setBackfillRunning(false);
    }
  }

  const [hrMissingCount, setHrMissingCount] = useState(null);
  const [hrRunning, setHrRunning] = useState(false);
  const [hrProgress, setHrProgress] = useState({ completed: 0, total: 0 });
  const [hrResult, setHrResult] = useState(null);
  const [hrError, setHrError] = useState('');

  useEffect(() => {
    HrBackfillService.countMissing().then(setHrMissingCount).catch(() => {});
  }, []);

  async function runHrBackfill() {
    setHrRunning(true);
    setHrError('');
    setHrResult(null);
    setHrProgress({ completed: 0, total: 0 });
    try {
      const result = await HrBackfillService.backfillAllSessions((completed, total) =>
        setHrProgress({ completed, total })
      );
      setHrResult(result);
      setHrMissingCount(await HrBackfillService.countMissing());
    } catch (e) {
      setHrError(e.message || 'HR backfill failed');
    } finally {
      setHrRunning(false);
    }
  }

  const [tier, setTier] = useState(null);
  const [summariesComputedAt, setSummariesComputedAt] = useState(null);
  const [summariesLoading, setSummariesLoading] = useState(false);
  const [indexStatus, setIndexStatus] = useState(null); // { indexed, total, lastIndexedAt }
  const [indexing, setIndexing] = useState(false);
  const [indexPhase, setIndexPhase] = useState('sessions'); // 'sessions' | 'notes'
  const [indexProgress, setIndexProgress] = useState({ completed: 0, total: 0 });
  const [indexResult, setIndexResult] = useState(null); // { sessions, notes }
  const [indexError, setIndexError] = useState('');

  useEffect(() => {
    TierService.getCachedTier().then(setTier);
    EmbeddingService.getIndexStatus().then(setIndexStatus).catch(() => {});
    SummaryService.getLastComputedAt().then(setSummariesComputedAt).catch(() => {});
  }, []);

  async function runRecomputeSummaries() {
    setSummariesLoading(true);
    try {
      await SummaryService.computeAllSummaries();
      const computedAt = await SummaryService.getLastComputedAt();
      setSummariesComputedAt(computedAt);
    } catch (err) {
      console.warn('[Settings] recompute summaries failed:', err.message);
    } finally {
      setSummariesLoading(false);
    }
  }

  // rebuild=true clears every existing embedding first, so sessions that
  // were already indexed (and would otherwise be skipped) get regenerated
  // too — for when the embedded text itself changed (e.g. adding HR),
  // making old rows stale rather than just incomplete.
  async function runIndexAllSessions({ rebuild = false } = {}) {
    setIndexing(true);
    setIndexError('');
    setIndexResult(null);
    setIndexPhase('sessions');
    setIndexProgress({ completed: 0, total: 0 });
    try {
      if (rebuild) await EmbeddingService.clearAll();

      // Chat (LocalAI) and indexing (EmbeddingService) each open their own
      // llama.cpp context — if Chat was used earlier this session, its
      // context is still resident. Two live contexts competing for memory
      // is a likely cause of a native "Failed to load model" mid-index, so
      // free the chat one first; it reloads lazily next time it's needed.
      await LocalAI.release();

      const sessionsResult = await EmbeddingService.embedAllSessions((completed, total) =>
        setIndexProgress({ completed, total })
      );

      const notes = await AnalysisRepository.getAllCoachingNotes();
      setIndexPhase('notes');
      setIndexProgress({ completed: 0, total: notes.length });
      let notesIndexed = 0;
      for (let i = 0; i < notes.length; i++) {
        try {
          const id = await EmbeddingService.embedCoachingNote(notes[i]);
          if (id != null) notesIndexed += 1;
        } catch (err) {
          // One note failing to embed (e.g. the same native load issue
          // that can hit embedAllSessions) shouldn't abort the rest.
          console.warn('[Settings] coaching note embed failed:', err.message);
        }
        setIndexProgress({ completed: i + 1, total: notes.length });
      }

      setIndexResult({ sessions: sessionsResult.embedded, notes: notesIndexed });
      if (sessionsResult.failed > 0) {
        setIndexError(
          `${sessionsResult.failed} session${sessionsResult.failed === 1 ? '' : 's'} failed to embed` +
          (sessionsResult.lastError ? `: ${sessionsResult.lastError}` : '')
        );
      }
      setIndexStatus(await EmbeddingService.getIndexStatus());
    } catch (e) {
      setIndexError(e.message || 'Indexing failed');
    } finally {
      setIndexing(false);
    }
  }

  // TEMPORARY DEBUG — remove once the beach-check weather caching issue is
  // confirmed fixed. Dumps the 10 most recently fetched weather_cache rows
  // so it's immediately visible whether the cache is empty, has stale
  // dates, or has the wrong beach name.
  async function checkWeatherCache() {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT beach_name, forecast_date, best_wind_kn, fetched_at
       FROM weather_cache
       ORDER BY fetched_at DESC
       LIMIT 10`
    );
    console.log('[Debug] weather_cache:', JSON.stringify(rows));
    Alert.alert(
      'Weather Cache',
      rows.length === 0
        ? 'Empty — no weather data cached'
        : rows.map((r) => `${r.beach_name} ${r.forecast_date} ${r.best_wind_kn}kn`).join('\n')
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container} style={styles.scrollBg}>
      <Header title="⚙️ Settings" />

      <Text style={styles.sectionLabel}>💾 Backup & Restore</Text>
      <SharedCard style={styles.previewCard}>
        <Text style={styles.previewName}>Export a full copy of everything in this app, or restore from a previous export.</Text>
      </SharedCard>
      {!!backupError && <Text style={styles.errorText}>⚠️ {backupError}</Text>}
      <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={handleExportBackup} disabled={backupBusy}>
        <Text style={styles.importBtnText}>{backupBusy ? 'Please wait…' : '⬆️ Export My Data'}</Text>
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={handleRestoreBackup} disabled={backupBusy}>
        <Text style={styles.viewImportBtnText}>⬇️ Restore from Backup</Text>
      </TouchableOpacity>

      <Text style={styles.sectionLabel}>🏄 Rider Profile</Text>
      <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.navigate('RiderProfile')}>
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewName}>🏄 Rider Profile ›</Text>
          {biometricCategory === undefined ? (
            <Text style={styles.imuDetailText}>Checking…</Text>
          ) : biometricCategory ? (
            <Text style={[styles.imuDetailText, { color: colors.green }]}>{biometricCategory}</Text>
          ) : (
            <Text style={[styles.imuDetailText, { color: ACCENT }]}>Not set up</Text>
          )}
        </SharedCard>
      </TouchableOpacity>

      <Text style={styles.sectionLabel}>📡 IMU Sensor</Text>
      <SharedCard style={styles.previewCard}>
        <Text style={styles.previewName}>
          {imuConnected ? 'Connected ✅' : 'Not connected'}
        </Text>
        {imuConnected && imuBatteryPct != null && (
          <Text style={styles.imuDetailText}>Battery: {imuBatteryPct}%</Text>
        )}
        {tier === TIERS.FREE ? (
          <Text style={styles.imuDetailText}>Upgrade to Premium or Ultimate to use an IMU sensor.</Text>
        ) : (
          <Text style={styles.imuDetailText}>
            {tier === TIERS.ULTIMATE ? 'Ultimate tier: 9-axis readings (accel + gyro + magnetometer).' : 'Premium tier: 6-axis readings (accel + gyro).'}
          </Text>
        )}
        {!imuConnected && (
          <Text style={styles.imuDetailText}>Without a sensor, foot pressure and fin load are estimated from body position only.</Text>
        )}
      </SharedCard>

      <Text style={styles.sectionLabel}>🔒 Site Password</Text>
      <SharedCard style={styles.previewCard}>
        {siteUnlocked === undefined ? (
          <Text style={styles.previewName}>Checking…</Text>
        ) : siteUnlocked ? (
          <Text style={styles.previewName}>Unlocked — Oracle requests are authorized.</Text>
        ) : (
          <Text style={styles.previewName}>Required before either account below can reach Oracle — same login the website asks for.</Text>
        )}
      </SharedCard>
      {!siteUnlocked && (
        <>
          <TextInput
            style={styles.identityInput}
            placeholder="Site username"
            placeholderTextColor="rgba(205,232,240,0.35)"
            autoCapitalize="none"
            autoCorrect={false}
            value={siteUsername}
            onChangeText={setSiteUsername}
          />
          <TextInput
            style={styles.identityInput}
            placeholder="Site password"
            placeholderTextColor="rgba(205,232,240,0.35)"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={sitePassword}
            onChangeText={setSitePassword}
          />
          {!!siteError && <Text style={styles.errorText}>⚠️ {siteError}</Text>}
          <TouchableOpacity activeOpacity={0.7}
            style={styles.importBtn}
            onPress={handleSiteUnlock}
            disabled={siteBusy || !siteUsername.trim() || !sitePassword}
          >
            <Text style={styles.importBtnText}>{siteBusy ? 'Saving…' : 'Unlock'}</Text>
          </TouchableOpacity>
        </>
      )}
      {!!siteUnlocked && (
        <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={handleSiteLock}>
          <Text style={styles.viewImportBtnText}>Forget Site Password</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionLabel}>👤 Account</Text>
      <SharedCard style={styles.previewCard}>
        {account === undefined ? (
          <Text style={styles.previewName}>Checking sign-in status…</Text>
        ) : account ? (
          <>
            <Text style={styles.previewName}>Signed in{account.email ? ` as ${account.email}` : ''}</Text>
            <Text style={styles.estimateText}>Your data stays on this device — signing in just gives it an identity for future syncing.</Text>
          </>
        ) : (
          <Text style={styles.previewName}>Not signed in — everything still works fully offline.</Text>
        )}
      </SharedCard>
      {!!authError && <Text style={styles.errorText}>⚠️ {authError}</Text>}
      {account === null && appleAvailable && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={handleSignIn} disabled={signingIn}>
          <Text style={styles.importBtnText}>{signingIn ? 'Signing in…' : '🍎 Sign in with Apple'}</Text>
        </TouchableOpacity>
      )}
      {!!account && (
        <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={handleSignOut}>
          <Text style={styles.viewImportBtnText}>Sign Out</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionLabel}>🔑 Oracle Sync Account</Text>
      <SharedCard style={styles.previewCard}>
        {identity === undefined ? (
          <Text style={styles.previewName}>Checking sign-in status…</Text>
        ) : identity ? (
          <>
            <Text style={styles.previewName}>Logged in as {identity.nickname}</Text>
            <Text style={styles.estimateText}>Same nickname+password system as the website — this is what session syncing to Oracle will use.</Text>
          </>
        ) : (
          <Text style={styles.previewName}>Not logged in — log in or register below to enable syncing sessions to Oracle.</Text>
        )}
      </SharedCard>
      {!identity && (
        <>
          <View style={styles.gearModeRowSettings}>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.identityModeBtn, identityMode === 'login' && styles.identityModeBtnActive]}
              onPress={() => { setIdentityMode('login'); setIdentityError(''); }}
            >
              <Text style={styles.identityModeBtnText}>Log In</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.identityModeBtn, identityMode === 'register' && styles.identityModeBtnActive]}
              onPress={() => { setIdentityMode('register'); setIdentityError(''); }}
            >
              <Text style={styles.identityModeBtnText}>Register</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.identityInput}
            placeholder="Nickname"
            placeholderTextColor="rgba(205,232,240,0.35)"
            autoCapitalize="none"
            autoCorrect={false}
            value={identityNickname}
            onChangeText={setIdentityNickname}
          />
          <TextInput
            style={styles.identityInput}
            placeholder="Password"
            placeholderTextColor="rgba(205,232,240,0.35)"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={identityPassword}
            onChangeText={setIdentityPassword}
          />
          {!!identityError && <Text style={styles.errorText}>⚠️ {identityError}</Text>}
          <TouchableOpacity activeOpacity={0.7}
            style={styles.importBtn}
            onPress={handleIdentitySubmit}
            disabled={identityBusy || !identityNickname.trim() || !identityPassword}
          >
            <Text style={styles.importBtnText}>
              {identityBusy ? 'Please wait…' : identityMode === 'register' ? 'Register' : 'Log In'}
            </Text>
          </TouchableOpacity>
        </>
      )}
      {!!identity && (
        <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={handleIdentityLogout}>
          <Text style={styles.viewImportBtnText}>Log Out</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionLabel}>☁️ Sync Sessions to Oracle</Text>
      <SharedCard style={styles.previewCard}>
        {unsyncedCount == null ? (
          <Text style={styles.previewName}>Checking sync status…</Text>
        ) : (
          <Text style={styles.previewName}>
            {unsyncedCount} session{unsyncedCount === 1 ? '' : 's'} not yet synced
          </Text>
        )}
        {(!siteUnlocked || !identity) && (
          <Text style={styles.estimateText}>Needs both Site Password and Oracle Sync Account above unlocked first.</Text>
        )}
      </SharedCard>

      {!syncRunning && (
        <TouchableOpacity activeOpacity={0.7} onPress={handleResetSyncState} style={{ marginBottom: 10 }}>
          <Text style={styles.viewImportBtnText}>Reset sync status (if a previous sync didn't actually land on Oracle)</Text>
        </TouchableOpacity>
      )}

      {!syncRunning && unsyncedCount > 0 && (
        <TouchableOpacity activeOpacity={0.7}
          style={styles.importBtn}
          onPress={runSync}
          disabled={!siteUnlocked || !identity}
        >
          <Text style={styles.importBtnText}>{syncResult ? '☁️ Sync Again' : '☁️ Sync to Oracle'}</Text>
        </TouchableOpacity>
      )}

      {syncRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Syncing sessions…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${syncProgress.total ? Math.round((syncProgress.completed / syncProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {syncProgress.completed} / {syncProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!syncError && <Text style={styles.errorText}>⚠️ {syncError}</Text>}

      {syncResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>{syncResult.success ? '✅' : '⚠️'}</Text>
            <Text style={[styles.resultTitle, { color: syncResult.success ? SAFE : ACCENT }]}>
              {syncResult.count} session{syncResult.count === 1 ? '' : 's'} synced
            </Text>
            {syncResult.errors.length > 0 && (
              <Text style={styles.resultSub}>{syncResult.errors.length} error(s) — check network and retry</Text>
            )}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>🌦️ Backfill Historical Weather</Text>
      <SharedCard style={styles.previewCard}>
        {missingWeatherCount == null ? (
          <Text style={styles.previewName}>Checking weather coverage…</Text>
        ) : (
          <Text style={styles.previewName}>
            {missingWeatherCount} session date{missingWeatherCount === 1 ? '' : 's'} missing weather data
          </Text>
        )}
      </SharedCard>

      {!backfillRunning && !backfillResult && missingWeatherCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runWeatherBackfill}>
          <Text style={styles.importBtnText}>🌦️ Backfill Historical Weather</Text>
        </TouchableOpacity>
      )}

      {backfillRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Fetching from Open-Meteo…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${backfillProgress.total ? Math.round((backfillProgress.completed / backfillProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {backfillProgress.completed} / {backfillProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!backfillError && <Text style={styles.errorText}>⚠️ {backfillError}</Text>}

      {backfillResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>{backfillResult.success ? '✅' : '⚠️'}</Text>
            <Text style={[styles.resultTitle, { color: backfillResult.success ? SAFE : ACCENT }]}>
              {backfillResult.count} date{backfillResult.count === 1 ? '' : 's'} backfilled
            </Text>
            {backfillResult.errors.length > 0 && (
              <Text style={styles.resultSub}>{backfillResult.errors.length} error(s) — check network and retry</Text>
            )}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>💨 Backfill Wind Gusts</Text>
      <SharedCard style={styles.previewCard}>
        {missingGustCount == null ? (
          <Text style={styles.previewName}>Checking gust coverage…</Text>
        ) : (
          <>
            <Text style={styles.previewName}>
              {missingGustCount} cached weather row{missingGustCount === 1 ? '' : 's'} missing gust data
            </Text>
            <Text style={styles.previewSize}>
              Covers weather imported or backfilled before gusts were tracked — average wind only, no gust figure.
            </Text>
          </>
        )}
      </SharedCard>

      {!gustBackfillRunning && !gustBackfillResult && missingGustCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runGustBackfill}>
          <Text style={styles.importBtnText}>💨 Backfill Wind Gusts</Text>
        </TouchableOpacity>
      )}

      {gustBackfillRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Fetching gusts from Open-Meteo…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${gustBackfillProgress.total ? Math.round((gustBackfillProgress.completed / gustBackfillProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {gustBackfillProgress.completed} / {gustBackfillProgress.total} rows
          </Text>
        </SharedCard>
      )}

      {!!gustBackfillError && <Text style={styles.errorText}>⚠️ {gustBackfillError}</Text>}

      {gustBackfillResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>{gustBackfillResult.success ? '✅' : '⚠️'}</Text>
            <Text style={[styles.resultTitle, { color: gustBackfillResult.success ? SAFE : ACCENT }]}>
              {gustBackfillResult.count} row{gustBackfillResult.count === 1 ? '' : 's'} backfilled
            </Text>
            {gustBackfillResult.errors.length > 0 && (
              <Text style={styles.resultSub}>{gustBackfillResult.errors.length} error(s) — check network and retry</Text>
            )}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>🎯 Rame Head Wind Backfill</Text>
      <SharedCard style={styles.previewCard}>
        {rameEligibleCount == null ? (
          <Text style={styles.previewName}>Checking sessions in range…</Text>
        ) : (
          <>
            <Text style={styles.previewName}>
              {rameEligibleCount} session{rameEligibleCount === 1 ? '' : 's'} near Rame Head
            </Text>
            <Text style={styles.previewSize}>
              Uses Rame Head NCI lookout data — more accurate than Open-Meteo for sessions near Torpoint
            </Text>
          </>
        )}
      </SharedCard>

      {!rameRunning && !rameResult && rameEligibleCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runRameHeadBackfill}>
          <Text style={styles.importBtnText}>🎯 Backfill from Rame Head</Text>
        </TouchableOpacity>
      )}

      {rameRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Fetching from Rame Head NCI archive…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${rameProgress.total ? Math.round((rameProgress.completed / rameProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {rameProgress.completed} / {rameProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!rameError && <Text style={styles.errorText}>⚠️ {rameError}</Text>}

      {rameResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {rameResult.updated} of {rameResult.total} updated
            </Text>
            <Text style={styles.resultSub}>{rameResult.skipped} skipped (existing data was better)</Text>
            {rameResult.failed > 0 && <Text style={styles.resultSub}>{rameResult.failed} failed</Text>}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>❤️ Heart Rate Backfill</Text>
      <SharedCard style={styles.previewCard}>
        {hrMissingCount == null ? (
          <Text style={styles.previewName}>Checking sessions…</Text>
        ) : (
          <>
            <Text style={styles.previewName}>
              {hrMissingCount} session{hrMissingCount === 1 ? '' : 's'} missing HR data
            </Text>
            <Text style={styles.previewSize}>
              Aggregates avg/max heart rate from imported GPS trackpoints — needed for the AI coach to reference HR (e.g. "HR vs speed")
            </Text>
          </>
        )}
      </SharedCard>

      {!hrRunning && !hrResult && hrMissingCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runHrBackfill}>
          <Text style={styles.importBtnText}>❤️ Backfill Heart Rate</Text>
        </TouchableOpacity>
      )}

      {hrRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Aggregating trackpoint HR…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${hrProgress.total ? Math.round((hrProgress.completed / hrProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {hrProgress.completed} / {hrProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!hrError && <Text style={styles.errorText}>⚠️ {hrError}</Text>}

      {hrResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {hrResult.updated} session{hrResult.updated === 1 ? '' : 's'} updated
            </Text>
            <Text style={styles.resultSub}>{hrResult.skipped} skipped (no trackpoint HR data, or already set)</Text>
            {hrResult.errors.length > 0 && <Text style={styles.resultSub}>{hrResult.errors.length} failed</Text>}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>📊 AI Context Summaries</Text>
      <SharedCard style={styles.previewCard}>
        <Text style={styles.previewName}>
          {summariesComputedAt ? `Last computed: ${formatLocalTime(summariesComputedAt)}` : 'Not computed yet'}
        </Text>
        <Text style={styles.previewSize}>
          Pre-computed year-by-year and recent-form stats the AI coach reads from, instead of re-deriving them from every session on each question.
        </Text>
      </SharedCard>
      <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runRecomputeSummaries} disabled={summariesLoading}>
        <Text style={styles.importBtnText}>{summariesLoading ? 'Computing…' : '📊 Recompute Summaries'}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionLabel}>🧠 AI Semantic Search</Text>
      {tier === null ? (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewName}>Checking access…</Text>
        </SharedCard>
      ) : !canAccess('FULL_ANALYSIS', tier) ? (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewName}>🔒 AI Semantic Search is a Premium feature</Text>
          <Text style={styles.previewSize}>Index your sessions for smarter AI coaching</Text>
        </SharedCard>
      ) : (
        <>
          <SharedCard style={styles.previewCard}>
            {!indexStatus ? (
              <Text style={styles.previewName}>Checking index status…</Text>
            ) : (
              <>
                <View style={styles.statusRow}>
                  <View style={[styles.statusDot, { backgroundColor: indexStatusColor(indexing, indexStatus) }]} />
                  <Text style={styles.previewName}>
                    {indexStatus.indexed > 0
                      ? `${indexStatus.indexed} of ${indexStatus.total} sessions indexed`
                      : 'Not indexed yet'}
                  </Text>
                </View>
                {indexStatus.lastIndexedAt && (
                  <Text style={styles.previewSize}>Last indexed: {formatLocalTime(indexStatus.lastIndexedAt)}</Text>
                )}
                <Text style={styles.previewSize}>
                  Embeddings run on-device via the already-downloaded Llama 3.2 3B Instruct model — first indexing may take several minutes.
                </Text>
              </>
            )}
          </SharedCard>

          {!indexing && !indexResult && indexStatus && indexStatus.indexed < indexStatus.total && (
            <>
              <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={() => runIndexAllSessions()}>
                <Text style={styles.importBtnText}>🧠 Index All Sessions</Text>
              </TouchableOpacity>
              <Text style={styles.estimateText}>
                ~{(indexStatus.total - indexStatus.indexed) * 3} seconds estimated
              </Text>
            </>
          )}

          {!indexing && !indexResult && indexStatus && indexStatus.indexed > 0 && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.viewImportBtn}
              onPress={() => runIndexAllSessions({ rebuild: true })}
            >
              <Text style={styles.viewImportBtnText}>♻️ Rebuild Index (re-embed everything)</Text>
            </TouchableOpacity>
          )}

          {indexing && (
            <SharedCard style={styles.progressCard}>
              <Text style={styles.progressLabel}>
                {indexPhase === 'notes' ? 'Indexing coaching notes…' : 'Indexing sessions…'}
              </Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${indexProgress.total ? Math.round((indexProgress.completed / indexProgress.total) * 100) : 0}%` },
                  ]}
                />
              </View>
              <Text style={styles.progressCount}>
                {indexProgress.completed} / {indexProgress.total} {indexPhase === 'notes' ? 'coaching notes' : 'sessions'}
              </Text>
            </SharedCard>
          )}

          {!!indexError && <Text style={styles.errorText}>⚠️ {indexError}</Text>}

          {indexResult && (
            <SharedCard style={styles.resultCard}>
              <View style={styles.resultCenter}>
                <Text style={styles.resultIcon}>✅</Text>
                <Text style={[styles.resultTitle, { color: SAFE }]}>
                  {indexResult.sessions} session{indexResult.sessions === 1 ? '' : 's'} indexed
                </Text>
                {indexResult.notes > 0 && (
                  <Text style={styles.resultSub}>
                    + {indexResult.notes} coaching note{indexResult.notes === 1 ? '' : 's'} indexed
                  </Text>
                )}
              </View>
            </SharedCard>
          )}
        </>
      )}

      <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={() => navigation.navigate('ImportData')}>
        <Text style={styles.viewImportBtnText}>📥 Import Historical Data (CSV)</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={checkWeatherCache}>
        <Text style={styles.viewImportBtnText}>🐛 Check Weather Cache (debug)</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: DEEP },
  container: { padding: 14, flexGrow: 1, paddingBottom: 40 },

  sectionLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(205,232,240,0.35)', marginBottom: 6 },

  previewCard: { marginBottom: 12 },
  previewName: { color: TEXT, fontSize: 13, fontWeight: '600' },
  imuDetailText: { color: 'rgba(205,232,240,0.6)', fontSize: 12, marginTop: 4 },
  previewSize: { color: 'rgba(205,232,240,0.4)', fontSize: 10, marginTop: 2 },

  gearModeRowSettings: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  identityModeBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  identityModeBtnActive: { backgroundColor: 'rgba(26,138,181,0.25)', borderColor: SKY },
  identityModeBtnText: { color: TEXT, fontSize: 12, fontWeight: '600' },
  identityInput: {
    backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: TEXT, fontSize: 14, marginBottom: 8,
  },

  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 9, height: 9, borderRadius: 4.5, marginRight: 7 },

  importBtn: {
    flexDirection: 'row',
    backgroundColor: SKY,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  importBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  estimateText: { color: 'rgba(205,232,240,0.4)', fontSize: 11, textAlign: 'center', marginTop: -4, marginBottom: 10 },

  errorText: { color: DANGER, textAlign: 'center', fontSize: 13, marginBottom: 10 },

  progressCard: { marginBottom: 12 },
  progressLabel: { color: TEXT, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  progressTrack: {
    height: 8,
    backgroundColor: 'rgba(205,232,240,0.15)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: { height: 8, backgroundColor: ACCENT, borderRadius: 4 },
  progressCount: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 6, textAlign: 'right' },

  resultCard: { marginBottom: 12 },
  resultCenter: { alignItems: 'center', paddingVertical: 4 },
  resultIcon: { fontSize: 26, marginBottom: 6 },
  resultTitle: { fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  resultSub: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginTop: 4, textAlign: 'center' },

  viewImportBtn: {
    width: '100%',
    marginTop: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 12,
    alignItems: 'center',
  },
  viewImportBtnText: { color: TEXT, fontSize: 13, fontWeight: '500' },
});
