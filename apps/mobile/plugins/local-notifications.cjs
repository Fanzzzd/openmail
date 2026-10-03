const { withAndroidManifest, withEntitlementsPlist } = require("expo/config-plugins");
/** Local notifications need POST_NOTIFICATIONS, never APNs or a Firebase messaging service. */
module.exports = (config) => {
  config = withEntitlementsPlist(config, (mod) => {
    delete mod.modResults["aps-environment"];
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest["uses-permission"] ??= [];
    if (
      !manifest["uses-permission"].some(
        (item) => item.$["android:name"] === "android.permission.POST_NOTIFICATIONS",
      )
    )
      manifest["uses-permission"].push({
        $: { "android:name": "android.permission.POST_NOTIFICATIONS" },
      });
    const application = manifest.application[0];
    application.service ??= [];
    application.service.push({
      $: {
        "android:name": "expo.modules.notifications.service.ExpoFirebaseMessagingService",
        "tools:node": "remove",
      },
    });
    application.service.push({
      $: {
        "android:name": "com.google.firebase.messaging.FirebaseMessagingService",
        "tools:node": "remove",
      },
    });
    application.receiver ??= [];
    application.receiver.push({
      $: {
        "android:name": "expo.modules.taskManager.TaskBroadcastReceiver",
        "android:exported": "false",
        "tools:node": "replace",
      },
      "intent-filter": [
        {
          action: [
            {
              $: { "android:name": "expo.modules.taskManager.TaskBroadcastReceiver.INTENT_ACTION" },
            },
          ],
        },
      ],
    });
    application["meta-data"] ??= [];
    application["meta-data"].push({
      $: {
        "android:name": "firebase_messaging_auto_init_enabled",
        "android:value": "false",
        "tools:replace": "android:value",
      },
    });
    return mod;
  });
};
