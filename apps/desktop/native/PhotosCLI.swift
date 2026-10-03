import AppKit
import PhotosUI
import ImageIO
import UniformTypeIdentifiers

// No PHPhotoLibrary access or authorization requests. PHPicker owns access.
let byteLimit = 30 * 1024 * 1024
let sourceByteLimit = 128 * 1024 * 1024
let helperIdentifier = "app.openmail.desktop.photos"
struct Labels: Decodable { let title: String; let instruction: String; let cancel: String }
struct Attachment: Encodable {
    let filename: String; let mimeType: String; let content: String
    var byteCount: Int { content.utf8.count / 4 * 3 - (content.hasSuffix("==") ? 2 : content.hasSuffix("=") ? 1 : 0) }
}
enum PickerError: Error { case invalidImage, tooLarge }
enum PickerStatus: String, Encodable { case ok, tooLarge, error }
struct PickerResult: Encodable {
    let status: PickerStatus; let files: [Attachment]; let skipped: Int
    static func failure(_ error: PickerError) -> PickerResult {
        PickerResult(status: error == .tooLarge ? .tooLarge : .error, files: [], skipped: error == .tooLarge ? 1 : 0)
    }
}
struct Batch {
    var files: [Attachment] = []
    var bytes = 0
    var skipped = 0
    let limit: Int
    init(limit: Int = byteLimit) { self.limit = limit }
    // An oversized item is skipped independently; later items can still fit.
    mutating func accept(_ result: Result<Attachment, PickerError>) -> PickerError? {
        switch result {
        case .failure(.tooLarge): skipped += 1
        case .failure(.invalidImage): return .invalidImage
        case .success(let file):
            if file.byteCount > limit - bytes { skipped += 1 }
            else { files.append(file); bytes += file.byteCount }
        }
        return nil
    }
    var result: PickerResult { PickerResult(status: skipped == 0 ? .ok : .tooLarge, files: files, skipped: skipped) }
}
func imageAttachment(_ data: Data, index: Int) throws -> Attachment {
    guard data.count <= sourceByteLimit else { throw PickerError.tooLarge }
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
            kCGImageSourceShouldCacheImmediately: true
          ] as CFDictionary) else { throw PickerError.invalidImage }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { throw PickerError.invalidImage }
    // Quality is a new destination setting. Image properties are nil; never copy metadata.
    CGImageDestinationSetProperties(destination, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw PickerError.invalidImage }
    guard output.length <= byteLimit else { throw PickerError.tooLarge }
    return Attachment(filename: "photo-\(index + 1).jpg", mimeType: "image/jpeg", content: (output as Data).base64EncodedString())
}
let imagePasteboardTypes = [UTType.heic.identifier, UTType.jpeg.identifier, UTType.png.identifier, UTType.tiff.identifier].map { NSPasteboard.PasteboardType($0) }
func importResult(read: (NSPasteboard.PasteboardType) -> Data?, limit: Int = byteLimit) -> PickerResult {
    do {
        if let data = read(.pdf) {
            guard data.count <= limit else { throw PickerError.tooLarge }
            return PickerResult(status: .ok, files: [Attachment(filename: "scan.pdf", mimeType: "application/pdf", content: data.base64EncodedString())], skipped: 0)
        }
        // Compressed representations first. Never inflate NSImage into a full TIFF.
        for type in imagePasteboardTypes {
            if let data = read(type) {
                let file = try imageAttachment(data, index: 0)
                guard file.byteCount <= limit else { throw PickerError.tooLarge }
                return PickerResult(status: .ok, files: [file], skipped: 0)
            }
        }
        throw PickerError.invalidImage
    } catch let error as PickerError { return .failure(error) }
    catch { return .failure(.invalidImage) }
}
func emit(_ result: PickerResult) {
    guard let data = try? JSONEncoder().encode(result) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func imageSelfTest() throws {
    // 6000 x 4000 = 24 MP. Grayscale keeps the synthetic fixture's memory bounded.
    let pixels = Data(repeating: 127, count: 6000 * 4000)
    let provider = CGDataProvider(data: pixels as CFData)!
    let image = CGImage(width: 6000, height: 4000, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: 6000,
                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let source = NSMutableData()
    let destination = CGImageDestinationCreateWithData(source, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, [
        kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 22.3, kCGImagePropertyGPSLatitudeRef: "N"],
        kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "private-location"]
    ] as CFDictionary)
    precondition(CGImageDestinationFinalize(destination))
    let fixture = CGImageSourceCreateWithData(source as Data as CFData, nil)!
    let original = CGImageSourceCopyPropertiesAtIndex(fixture, 0, nil)! as NSDictionary
    precondition(original[kCGImagePropertyPixelWidth] as? Int == 6000 && original[kCGImagePropertyPixelHeight] as? Int == 4000)
    precondition(original[kCGImagePropertyGPSDictionary] != nil)
    let result = try imageAttachment(source as Data, index: 0)
    let cleaned = CGImageSourceCreateWithData(Data(base64Encoded: result.content)! as CFData, nil)!
    let properties = CGImageSourceCopyPropertiesAtIndex(cleaned, 0, nil)! as NSDictionary
    precondition(properties[kCGImagePropertyGPSDictionary] == nil)
    precondition((properties[kCGImagePropertyExifDictionary] as? NSDictionary)?[kCGImagePropertyExifUserComment] == nil)
    precondition(!properties.description.contains("private-location"))
    guard let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int else { preconditionFailure() }
    precondition(width > 0 && width <= 4096 && height > 0 && height <= 4096)
    precondition(result.mimeType == "image/jpeg" && result.byteCount < byteLimit)
    var requested: [NSPasteboard.PasteboardType] = []
    let imported = importResult { type in
        requested.append(type)
        return type.rawValue == UTType.jpeg.identifier ? source as Data : nil
    }
    precondition(imported.status == .ok && imported.files.count == 1)
    precondition(requested == [.pdf, NSPasteboard.PasteboardType(UTType.heic.identifier), NSPasteboard.PasteboardType(UTType.jpeg.identifier)])
    precondition(importResult(read: { _ in Data([1, 2, 3]) }).status == .ok) // PDF representation, size-only path.
    precondition(importResult(read: { $0 == .pdf ? nil : Data([1, 2, 3]) }).status == .error)
    precondition(importResult(read: { $0 == .pdf ? Data([1, 2, 3]) : nil }, limit: 2).status == .tooLarge)
    var batch = Batch(limit: 4)
    precondition(batch.accept(.failure(.tooLarge)) == nil)
    precondition(batch.accept(.success(Attachment(filename: "large.jpg", mimeType: "image/jpeg", content: Data(repeating: 1, count: 5).base64EncodedString()))) == nil)
    precondition(batch.accept(.success(Attachment(filename: "small.jpg", mimeType: "image/jpeg", content: Data([1, 2, 3]).base64EncodedString()))) == nil)
    precondition(batch.result.status == .tooLarge && batch.result.skipped == 2 && batch.result.files.count == 1)
    precondition(batch.bytes == 3)
    precondition(batch.accept(.failure(.invalidImage)) == .invalidImage)
}
func selfTest() throws {
    precondition(Bundle.main.bundleIdentifier == helperIdentifier)
    precondition(Bundle.main.object(forInfoDictionaryKey: "LSMinimumSystemVersion") as? String == "13.0")
    try autoreleasepool { try imageSelfTest() }
    emit(Batch().result)
}

final class ImportView: NSView, NSServicesMenuRequestor {
    var receive: ((PickerResult) -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
        if sendType == nil, let type = returnType, type == .pdf || NSImage.imageTypes.contains(type.rawValue) { return self }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }
    func readSelection(from pasteboard: NSPasteboard) -> Bool {
        // Consume the service response even on failure: the session emits an error and ends.
        receive?(importResult { pasteboard.data(forType: $0) })
        return true
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        NSMenu.popUpContextMenu(NSMenu(), with: event, for: self)
    }
    override func rightMouseDown(with event: NSEvent) { mouseDown(with: event) }
}

final class PickerSession: NSObject, NSApplicationDelegate, NSWindowDelegate, PHPickerViewControllerDelegate {
    let labels: Labels
    let continuity: Bool
    var window: NSWindow?
    var picker: PHPickerViewController?
    var finished = false
    var batch = Batch()
    init(labels: Labels, continuity: Bool) { self.labels = labels; self.continuity = continuity }
    func finish(_ result: PickerResult) {
        guard !finished else { return }
        finished = true
        emit(result)
        NSApplication.shared.terminate(nil)
    }
    @objc func cancel(_ sender: Any?) { finish(Batch().result) }
    func windowWillClose(_ notification: Notification) { finish(Batch().result) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let app = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: continuity ? 200 : 560),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        self.window = window
        window.delegate = self
        window.title = labels.title
        window.isReleasedWhenClosed = false
        if continuity {
            let view = ImportView(frame: window.contentView!.bounds)
            view.autoresizingMask = [.width, .height]
            view.receive = { [weak self] result in self?.finish(result) }
            window.contentView = view
            let instruction = NSTextField(wrappingLabelWithString: labels.instruction)
            instruction.frame = NSRect(x: 24, y: 90, width: 592, height: 80)
            view.addSubview(instruction)
            let button = NSButton(title: labels.cancel, target: self, action: #selector(cancel(_:)))
            button.frame = NSRect(x: 530, y: 20, width: 86, height: 32)
            button.keyEquivalent = "\u{1b}"
            view.addSubview(button)
            let menu = NSMenu()
            let item = NSMenuItem(title: labels.title, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            let camera = NSMenuItem(title: labels.title, action: nil, keyEquivalent: "")
            camera.identifier = NSMenuItem.importFromDeviceIdentifier
            submenu.addItem(camera)
            submenu.addItem(NSMenuItem(title: labels.cancel, action: #selector(cancel(_:)), keyEquivalent: "w"))
            item.submenu = submenu
            menu.addItem(item)
            app.mainMenu = menu
            window.makeFirstResponder(view)
        } else {
            var configuration = PHPickerConfiguration()
            configuration.filter = .images
            configuration.selectionLimit = 16
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            self.picker = picker
            window.contentViewController = picker
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        if results.isEmpty { finish(Batch().result); return }
        load(results, index: 0)
    }
    func load(_ results: [PHPickerResult], index: Int) {
        guard !finished else { return }
        guard index < results.count else { finish(batch.result); return }
        results[index].itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] url, error in
            // Provider URLs are valid only during this callback. Read and sanitize here.
            let result: Result<Attachment, PickerError>
            do {
                guard error == nil, let url = url,
                      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize else { throw PickerError.invalidImage }
                guard size <= sourceByteLimit else { throw PickerError.tooLarge }
                result = .success(try imageAttachment(Data(contentsOf: url), index: index))
            } catch let error as PickerError { result = .failure(error) }
            catch { result = .failure(.invalidImage) }
            DispatchQueue.main.async {
                guard let self = self, !self.finished else { return }
                if let error = self.batch.accept(result) { self.finish(.failure(error)) }
                else { self.load(results, index: index + 1) }
            }
        }
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--self-test"] { do { try selfTest(); exit(0) } catch { exit(1) } }
guard arguments == ["--photos"] || arguments == ["--continuity"], Bundle.main.bundleIdentifier == helperIdentifier else { exit(2) }
guard let labels = try? JSONDecoder().decode(Labels.self, from: FileHandle.standardInput.readDataToEndOfFile()) else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let session = PickerSession(labels: labels, continuity: arguments == ["--continuity"])
app.delegate = session
app.run()
