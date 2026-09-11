// plugins/withGoProSDK.js
// Ported from the production app's plugin of the same name. Generates the
// GoProMediaModule Swift/ObjC bridge on every prebuild and wires it + the
// GoProMediaSDK pod into the native project — adapted here to use this
// app's actual native project name ("windsurfcommanderultra") instead of
// the production app's hardcoded "WindsurfCommander".
const { withPodfile, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const SWIFT_MODULE = `import Foundation
import GoProMediaSDK

@objc(GoProMediaModule)
class GoProMediaModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  @objc func exportGPX(
    _ inputPath: String,
    outputPath: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let inputURL = URL(fileURLWithPath: inputPath)
        let outputURL = URL(fileURLWithPath: outputPath)
        let outputDir = outputURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try GoProMediaSDK.exportGPX(inputUrl: inputURL, outputUrl: outputURL)
        resolve(outputURL.path)
      } catch {
        reject("GOPRO_GPX_ERROR", "GPX export failed: \\(error.localizedDescription)", error)
      }
    }
  }

  @objc func exportERP(
    _ inputPath: String,
    outputPath: String,
    widthPx: Int,
    heightPx: Int,
    useHEVC: Bool,
    stabilize: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    var shouldCancel = false
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let inputURL = URL(fileURLWithPath: inputPath)
        let outputURL = URL(fileURLWithPath: outputPath)
        let outputDir = outputURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let clampedHeight = max(500, min(2688, UInt16(heightPx)))
        let resolution = GoProResolution(width: UInt16(widthPx), height: clampedHeight)
        let codec: GPCodec = useHEVC ? .HEVC : .H264
        let stabilization: GPStabilization = stabilize ? .allOn : .allOff

        let options = GoProExportOptions(
          inputUrl: inputURL,
          outputUrl: outputURL,
          resolution: resolution,
          codec: codec,
          stabilization: stabilization,
          bitrate: 0
        )

        exportEquirectangular(options, cancellation: { shouldCancel }, progress: { _ in })

        if shouldCancel {
          try? FileManager.default.removeItem(at: outputURL)
          reject("GOPRO_ERP_CANCELLED", "Cancelled", nil)
        } else {
          resolve(outputURL.path)
        }
      } catch {
        reject("GOPRO_ERP_ERROR", "ERP export failed: \\(error.localizedDescription)", error)
      }
    }
  }
}
`;

const OBJC_MODULE = `#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(GoProMediaModule, NSObject)

RCT_EXTERN_METHOD(exportGPX:(NSString *)inputPath
                  outputPath:(NSString *)outputPath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(exportERP:(NSString *)inputPath
                  outputPath:(NSString *)outputPath
                  widthPx:(NSInteger)widthPx
                  heightPx:(NSInteger)heightPx
                  useHEVC:(BOOL)useHEVC
                  stabilize:(BOOL)stabilize
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
`;

const BRIDGING_HEADER = `//
// Use this file to import your target's public headers that you would like to expose to Swift.
//
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
`;

function generateUUID() {
  return 'AABBCCDD' + Math.random().toString(16).slice(2, 10).toUpperCase() +
    Math.random().toString(16).slice(2, 10).toUpperCase();
}

function withGoProNativeFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;
      // This app's native folder is named after the Expo project name
      // (see app.json "name"), not hardcoded like the production app's
      // "WindsurfCommander" — config-plugins exposes it as projectName.
      const nativeDirName = config.modRequest.projectName;
      const iosDir = path.join(projectRoot, nativeDirName);

      fs.writeFileSync(path.join(iosDir, 'GoProMediaModule.swift'), SWIFT_MODULE);
      console.log('[withGoProSDK] Written GoProMediaModule.swift');

      fs.writeFileSync(path.join(iosDir, 'GoProMediaModule.m'), OBJC_MODULE);
      console.log('[withGoProSDK] Written GoProMediaModule.m');

      const bridgingHeaderPath = path.join(iosDir, `${nativeDirName}-Bridging-Header.h`);
      const existing = fs.existsSync(bridgingHeaderPath)
        ? fs.readFileSync(bridgingHeaderPath, 'utf8') : '';
      if (!existing.includes('RCTBridgeModule')) {
        fs.writeFileSync(bridgingHeaderPath, BRIDGING_HEADER);
        console.log('[withGoProSDK] Updated bridging header');
      }

      const pbxprojPath = path.join(
        projectRoot,
        `${nativeDirName}.xcodeproj`,
        'project.pbxproj'
      );

      let pbx = fs.readFileSync(pbxprojPath, 'utf8');

      if (pbx.includes('GoProMediaModule')) {
        console.log('[withGoProSDK] Files already in project.pbxproj');
        return config;
      }

      const swiftFileRefUUID  = generateUUID();
      const swiftBuildUUID    = generateUUID();
      const objcFileRefUUID   = generateUUID();
      const objcBuildUUID     = generateUUID();

      const fileRefMarker = '/* End PBXFileReference section */';
      const fileRefs = `\t\t${swiftFileRefUUID} /* GoProMediaModule.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = GoProMediaModule.swift; sourceTree = "<group>"; };
\t\t${objcFileRefUUID} /* GoProMediaModule.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = GoProMediaModule.m; sourceTree = "<group>"; };
\t\t`;
      pbx = pbx.replace(fileRefMarker, fileRefs + fileRefMarker);

      const buildFileMarker = '/* End PBXBuildFile section */';
      const buildFiles = `\t\t${swiftBuildUUID} /* GoProMediaModule.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${swiftFileRefUUID} /* GoProMediaModule.swift */; };
\t\t${objcBuildUUID} /* GoProMediaModule.m in Sources */ = {isa = PBXBuildFile; fileRef = ${objcFileRefUUID} /* GoProMediaModule.m */; };
\t\t`;
      pbx = pbx.replace(buildFileMarker, buildFiles + buildFileMarker);

      const groupMarker = /(\t\t\t\t[A-F0-9]+ \/\* AppDelegate\.swift \*\/,)/;
      const groupEntry = `\t\t\t\t${swiftFileRefUUID} /* GoProMediaModule.swift */,\n\t\t\t\t${objcFileRefUUID} /* GoProMediaModule.m */,\n`;
      pbx = pbx.replace(groupMarker, (match) => groupEntry + match);

      const sourcesMarker = /(\t\t\t\t[A-F0-9]+ \/\* AppDelegate\.swift in Sources \*\/,)/;
      const sourcesEntry = `\t\t\t\t${swiftBuildUUID} /* GoProMediaModule.swift in Sources */,\n\t\t\t\t${objcBuildUUID} /* GoProMediaModule.m in Sources */,\n`;
      pbx = pbx.replace(sourcesMarker, (match) => sourcesEntry + match);

      // Bake the file's "name"/"path" split into the pbxproj directly, so no
      // manual sed step is needed after prebuild (this is what production's
      // README sed command used to do by hand).
      pbx = pbx.replace(
        /lastKnownFileType = sourcecode\.swift; path = GoProMediaModule\.swift/g,
        `lastKnownFileType = sourcecode.swift; name = GoProMediaModule.swift; path = ${nativeDirName}/GoProMediaModule.swift`
      );
      pbx = pbx.replace(
        /lastKnownFileType = sourcecode\.c\.objc; path = GoProMediaModule\.m/g,
        `lastKnownFileType = sourcecode.c.objc; name = GoProMediaModule.m; path = ${nativeDirName}/GoProMediaModule.m`
      );

      fs.writeFileSync(pbxprojPath, pbx);
      console.log('[withGoProSDK] Patched project.pbxproj with GoProMediaModule files');

      return config;
    },
  ]);
}

function withGoProPodfile(config) {
  return withPodfile(config, (config) => {
    const contents = config.modResults.contents;

    if (contents.includes('GoProMediaSDK')) {
      console.log('[withGoProSDK] GoProMediaSDK already in Podfile');
      return config;
    }

    config.modResults.contents = contents.replace(
      'use_react_native!(',
      "pod 'GoProMediaSDK', :path => '../vendor'\n\n  use_react_native!("
    );

    console.log('[withGoProSDK] Added GoProMediaSDK pod to Podfile');
    return config;
  });
}

function withGoProSDK(config) {
  config = withGoProNativeFiles(config);
  config = withGoProPodfile(config);
  return config;
}

module.exports = withGoProSDK;
