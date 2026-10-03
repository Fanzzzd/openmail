import ExpoModulesCore
import Foundation
import Network

private enum StorageError: Error {
  case invalidDirectory
  case backupExclusionFailed
}

public final class OpenmailStorageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenmailStorage")
    AsyncFunction("backgroundNetworkAllowed") { (promise: Promise) in
      let monitor = NWPathMonitor()
      monitor.pathUpdateHandler = { path in
        monitor.pathUpdateHandler = nil
        monitor.cancel()
        promise.resolve(path.status == .satisfied && !path.isConstrained && !path.isExpensive)
      }
      monitor.start(queue: DispatchQueue(label: "openmail.background-network"))
    }
    Function("excludeFromBackup") { (uri: String) throws -> Void in
      let manager = FileManager.default
      let documents = try manager.url(for: .documentDirectory, in: .userDomainMask,
                                      appropriateFor: nil, create: false)
      let cache = try manager.url(for: .cachesDirectory, in: .userDomainMask,
                                 appropriateFor: nil, create: false)
      let roots = [documents.appendingPathComponent("openmail-data"),
                   documents.appendingPathComponent("openmail"),
                   cache.appendingPathComponent("openmail")]
      guard var directory = URL(string: uri), directory.isFileURL,
            roots.contains(where: { $0.standardizedFileURL.path == directory.standardizedFileURL.path }) else {
        throw StorageError.invalidDirectory
      }
      do {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        guard try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true else {
          throw StorageError.backupExclusionFailed
        }
      } catch {
        throw StorageError.backupExclusionFailed
      }
    }
  }
}
