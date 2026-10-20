# Dependency patches

`patchedDependencies` in `pnpm-workspace.yaml` lists the patches in `patches/`. Each patch is bound to a version number. When a dependency is upgraded, pnpm fails on the version mismatch. At that point, use the conditions below to decide whether to delete the patch or redo it. All three patches affect only mobile. The last two sections are version overrides. Review the Effect one when upgrading Effect, and the lightningcss one when upgrading Tailwind.

## react-native-tcp-socket@6.4.3

TCP and TLS transport for IMAP and SMTP. The patch changes four things:

- TLS connections on Android check the certificate hostname. Upstream issue [#239](https://github.com/Rapsssito/react-native-tcp-socket/issues/239), fix PR [#240](https://github.com/Rapsssito/react-native-tcp-socket/pull/240).
- iOS does not emit `connect` before the TLS handshake completes. Upstream issue [#237](https://github.com/Rapsssito/react-native-tcp-socket/issues/237), fix PR [#238](https://github.com/Rapsssito/react-native-tcp-socket/pull/238).
- STARTTLS upgrade on Android. The read thread yields the socket during the upgrade and no longer reads plaintext ahead with `BufferedInputStream`, which would swallow handshake bytes. It emits `connect` after the upgrade completes.
- Both platforms emit `secureConnect` only after the STARTTLS handshake completes (`react-native-tcp-socket/src/TLSSocket.js`, `react-native-tcp-socket/src/index.js`).

The last two changes have no upstream issue yet. Delete the patch when #240 and #238 are merged and released, and the new version's STARTTLS upgrade waits for the handshake to complete before emitting `secureConnect` on both Android and iOS.

## expo-background-task@57.0.21

Mobile background refresh (see [apps/mobile/README.md](../apps/mobile/README.md)). On iOS the patch replaces `BGProcessingTask` with `BGAppRefreshTask` (background mode `fetch`, identifier `com.openmail.mobile.refresh`) and removes a redundant `url` check in the task expiration notification. On Android it changes the WorkManager constraints to an unmetered network and battery not low, and attaches them to every task request.

Upstream issue [expo/expo#48122](https://github.com/expo/expo/issues/48122) proposes making the network constraint configurable. The task type, identifier and battery constraint have no upstream issue. They are OpenMail's own choices. Delete the patch when expo-background-task lets each task choose app refresh and custom constraints. Until then, redo this patch on every upgrade.

## expo-notifications@57.0.22

Local new-mail notifications. The patch does OpenMail-specific work and has no matching upstream bug:

- It removes `RECEIVE_BOOT_COMPLETED`, the boot broadcast and the Firebase messaging service from the library's AndroidManifest. OpenMail has no push and does not reschedule after boot.
- Android groups notifications by `openmailAccount` and builds the public lock screen version from `openmailPublicTitle`, so the lock screen does not show the sender or subject.
- iOS sets `threadIdentifier` from `openmailThread`, so notifications from the same conversation form one group.

Delete conditions: the manifest part can move to an app config plugin that removes the entries with `tools:node="remove"`. Grouping, the public version and `threadIdentifier` must wait until expo-notifications local notification content offers matching fields.

## Version override: @effect/platform-node-shared

`overrides` in `pnpm-workspace.yaml` pins `@effect/platform-node-shared` to 4.0.3. Effect packages are released together under one version number. `@effect/platform-node` 4.0.3 declares its dependency on it as `^4.0.3`, so pnpm resolves 4.0.4, and 4.0.4 requires effect 4.0.4. Without this override, desktop and the CLI would run 4.0.4 platform code on effect 4.0.3.

Dependabot does not change `overrides`. Dependabot's #14 upgraded only `@effect/platform-node` to 4.0.3. The override still kept `platform-node-shared` at 4.0.2, which has no `NodeAddressResolver.js`, and 12 core test files failed at import. When upgrading the Effect family, handle this override in the same commit. Delete it if the new `@effect/platform-node` resolves to a `platform-node-shared` of the same version. Otherwise change it to the new version number. After Effect releases the next patch version, the `^` range usually passes the current version again, so you usually change the version number. Run `pnpm peers check` to confirm there is no unmet effect peer.

## Version override: lightningcss

`@tailwindcss/node` 4.3.3 pins lightningcss to 1.32.0. Tailwind uses it to minify the generated CSS. 1.32.0 does not recognize the `::highlight()` pseudo-element, so the five `::highlight(openmail-*)` rules in the desktop `styles.css` print "Found 5 warnings while optimizing generated CSS" on every build. The rules are output unchanged, so the warning is a false positive. 1.33.0 parses `::highlight()`. `"@tailwindcss/node>lightningcss": 1.33.0` in `overrides` replaces only the copy that Tailwind uses.

Delete the override when `@tailwindcss/node` depends on lightningcss 1.33 or later. After deleting it, run `pnpm build` and confirm that neither the desktop app nor the docs site prints this warning.
