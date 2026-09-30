import { Alert, Linking } from 'react-native';

/**
 * Opens a URL in the device's browser.
 *
 * These links point at the hosted privacy policy and terms of service. A rider
 * tapping one and getting nothing would look like the app is broken, so a
 * failure says so and repeats the address rather than staying silent.
 */
export async function openExternalLink(url, label) {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert(label, `Couldn't open the link.\n\n${url}`);
  }
}
