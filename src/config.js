export const TELEGRAM_BOT_TOKEN = '';
export const APP_ENV = 'development';

// Gates development-only tooling. Currently the Settings button that clears the
// monthly usage caps — see UsageLimits.resetUsage(). Left true while testing,
// because the caps otherwise block a test run for the rest of the calendar
// month, and the test device runs Release builds where React Native's __DEV__ is
// false and cannot be used to gate it.
//
// SET THIS FALSE before any build goes to TestFlight or the App Store. The caps
// are what the paid tiers meter; a rider who can reach this button can give
// themselves unlimited analyses.
export const DEV_TOOLS = true;

// Hosted copies of the documents in docs/legal/. Both must stay public and
// readable without signing in: App Store Connect links directly to the privacy
// policy URL, and App Review checks that it resolves.
export const PRIVACY_POLICY_URL = 'https://windsurf.surfkat.co.uk/privacy';
export const TERMS_OF_SERVICE_URL = 'https://windsurf.surfkat.co.uk/terms';
