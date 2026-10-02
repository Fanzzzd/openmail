import Foundation
import CoreServices

// Launch Services supplies only applications registered for this file type.
guard CommandLine.arguments.count == 2 else { exit(2) }
let file = URL(fileURLWithPath: CommandLine.arguments[1])
let applications = LSCopyApplicationURLsForURL(file as CFURL, .all)?.takeRetainedValue() as? [URL] ?? []
let paths = Array(Set(applications.filter { $0.isFileURL && $0.pathExtension == "app" }.map { $0.path })).sorted()
let data = try JSONSerialization.data(withJSONObject: paths)
FileHandle.standardOutput.write(data)
