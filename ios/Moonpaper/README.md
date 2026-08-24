# Moonpaper for iPhone

Native SwiftUI client for Moonpaper's live Solana research API. It is not a
web wrapper: New/Trending discovery, search, research, risk explanations, and
the FOMO handoff are native views backed by typed API models.

## Requirements

- macOS with Xcode 26 or later (Apple requires the iOS 26 SDK for current App
  Store uploads)
- XcodeGen (`brew install xcodegen`)
- An active Apple Developer Program membership for device distribution,
  TestFlight, and the App Store

## Open and run

```bash
cd ios/Moonpaper
xcodegen generate
open Moonpaper.xcodeproj
```

In Xcode:

1. Select the **Moonpaper** target, then **Signing & Capabilities**.
2. Choose your Apple Developer team.
3. Change `com.ind1254.moonpaper` if that bundle identifier is unavailable.
4. Select an iPhone simulator or device and press Run.

The production API base URL is defined in
`Moonpaper/Core/AppConfig.swift`. No FOMO credentials, wallet keys, seed
phrases, or transaction code belong in this project.

## App Store release

1. Test New, Trending, search, research, refresh, Share, Privacy, Support, and
   the manual FOMO link on a physical iPhone.
2. In Xcode choose **Product → Archive**, validate the archive, and upload it to
   App Store Connect.
3. Create the App Store record with the metadata in `AppStore/` and answer the
   privacy questionnaire based on the deployed service's actual practices.
4. Add iPhone screenshots, select the uploaded build, provide review notes,
   then submit it to App Review.

This Windows workspace can validate source structure and live API contracts,
but only macOS/Xcode can compile, sign, archive, and upload an iOS binary.

