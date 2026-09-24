// plugins/withSceneDelegateFix.js
//
// iOS 27 asserts at launch unless the app adopts the scene-based life
// cycle — Expo's default generated AppDelegate.swift (as of this SDK)
// doesn't wire that up on its own, which was a real crash-on-launch bug
// hit earlier in this project. The fix (ExpoReactNativeFactoryProvider
// conformance + ExpoAppSceneDelegate) was previously applied by hand,
// directly to the generated ios/ folder — which is gitignored, so it
// silently disappeared on the next `expo prebuild --clean` with no
// warning. This plugin reapplies it automatically on every prebuild
// instead, the same way withGoProSDK.js keeps GoProMediaModule wired in.
const { withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const APP_DELEGATE_SWIFT = `internal import Expo
import React
import ReactAppDependencyProvider

// ExpoReactNativeFactoryProvider conformance is what lets ExpoAppSceneDelegate
// (see application(_:configurationForConnecting:options:) below) retrieve the
// factory this class creates — required by iOS 27, which asserts at launch
// unless the app adopts the scene-based life cycle. \`window\` and
// \`reactNativeFactory\` below already satisfy the protocol's requirements.
@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // Window creation and React Native startup now happen in
    // ExpoAppSceneDelegate.scene(_:willConnectTo:options:) instead — see
    // application(_:configurationForConnecting:options:) below. Doing it
    // here too (the pre-iOS-27 pattern) would start React Native twice
    // under the scene-based life cycle.

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Required by iOS 27, which asserts at launch unless the app adopts the
  // scene-based life cycle. ExpoAppSceneDelegate (shipped by the \`expo\`
  // package) creates the window and starts React Native once the scene
  // connects; this class becomes reachable to it via the
  // ExpoReactNativeFactoryProvider conformance declared above.
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = ExpoAppSceneDelegate.self
    return configuration
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

function withSceneDelegateFix(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;
      const nativeDirName = config.modRequest.projectName;
      const appDelegatePath = path.join(projectRoot, nativeDirName, 'AppDelegate.swift');

      fs.writeFileSync(appDelegatePath, APP_DELEGATE_SWIFT);
      console.log('[withSceneDelegateFix] Wrote iOS-27 scene-delegate fix into AppDelegate.swift');

      return config;
    },
  ]);
}

module.exports = withSceneDelegateFix;
