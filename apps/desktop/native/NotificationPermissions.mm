// Node-API keeps this bridge independent of Node/Electron's C++ ABI.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

struct PermissionWork {
  napi_deferred deferred;
  napi_async_work work;
  bool request;
  int32_t status = -1;
};

static void Execute(napi_env env, void *data) {
  auto *work = static_cast<PermissionWork *>(data);
  @autoreleasepool {
    @try {
      UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
      if (work->request) {
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
          completionHandler:^(BOOL granted, NSError *error) { dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC)) != 0) return;
      }
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block NSInteger status = -1;
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        status = settings.authorizationStatus;
        dispatch_semaphore_signal(done);
      }];
      if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0)
        work->status = static_cast<int32_t>(status);
    } @catch (NSException *exception) {
      work->status = -1;
    }
  }
}

static void Complete(napi_env env, napi_status status, void *data) {
  auto *work = static_cast<PermissionWork *>(data);
  napi_value result;
  napi_create_int32(env, status == napi_ok ? work->status : -1, &result);
  napi_resolve_deferred(env, work->deferred, result);
  napi_delete_async_work(env, work->work);
  delete work;
}

static napi_value Permission(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  auto *work = new PermissionWork{};
  work->request = false;
  if (argc) napi_get_value_bool(env, args[0], &work->request);
  napi_value promise, name;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "NotificationPermissions", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, Execute, Complete, work, &work->work) != napi_ok) {
    delete work;
    napi_throw_error(env, nullptr, "Cannot create notification permission request");
    return nullptr;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    napi_delete_async_work(env, work->work);
    delete work;
    napi_throw_error(env, nullptr, "Cannot queue notification permission request");
    return nullptr;
  }
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "permission", NAPI_AUTO_LENGTH, Permission, nullptr, &function);
  napi_set_named_property(env, exports, "permission", function);
  return exports;
}
NAPI_MODULE(notification_permissions, Init)
