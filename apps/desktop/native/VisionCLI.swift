import Foundation
import Vision
import ImageIO

struct TextLine: Codable {
    let text: String
    let confidence: Float
    // Pixels in the original image, top-left origin.
    let region: Region
}

struct Box: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Region: Codable { let box: Box; let tile: Box; let imageWidth: Int; let imageHeight: Int }
struct Result: Codable { let revision: Int; let lines: [TextLine] }

enum CLIError: Error { case usage, image, crop }

func load(_ path: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 16384, height <= 65536,
          width * height <= 100_000_000 else { throw CLIError.image }
    // Match the upright image displayed by browsers, including JPEG EXIF orientation.
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(width, height)
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        throw CLIError.image
    }
    return image
}

func recognize(_ image: CGImage, tiled: Bool) throws -> [TextLine] {
    let height = image.height
    let tileHeight = tiled ? min(1024, height) : height
    let overlap = tiled ? 128 : 0
    var starts = [0]
    while let last = starts.last, last + tileHeight < height {
        starts.append(last + tileHeight - overlap)
    }
    var lines: [TextLine] = []
    for (index, top) in starts.enumerated() {
        let h = min(tileHeight, height - top)
        guard let crop = image.cropping(to: CGRect(x: 0, y: top, width: image.width, height: h)) else {
            throw CLIError.crop
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0
        try VNImageRequestHandler(cgImage: crop, orientation: .up).perform([request])
        let ownershipTop = index == 0 ? 0.0 : Double(top + overlap / 2)
        let ownershipBottom = index == starts.count - 1 ? Double(height) : Double(top + h - overlap / 2)
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let b = observation.boundingBox
            let y = Double(top) + (1 - b.maxY) * Double(h)
            let boxHeight = b.height * Double(h)
            let center = y + boxHeight / 2
            // Assign the overlapping band by the center of the text box.
            if center < ownershipTop || center >= ownershipBottom { continue }
            lines.append(TextLine(text: candidate.string, confidence: candidate.confidence,
                region: Region(box: Box(x: b.minX * Double(image.width), y: y, width: b.width * Double(image.width), height: boxHeight), tile: Box(x: 0, y: Double(top), width: Double(image.width), height: Double(h)), imageWidth: image.width, imageHeight: height)))
        }
    }
    return lines.sorted {
        if abs($0.region.box.y - $1.region.box.y) > min($0.region.box.height, $1.region.box.height) / 2 { return $0.region.box.y < $1.region.box.y }
        return $0.region.box.x < $1.region.box.x
    }
}


do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["--version"] { print(VNRecognizeTextRequest.defaultRevision) }
    else {
        guard args.count == 1 else { throw CLIError.usage }
        let image = try load(args[0])
        guard image.width <= 16384, image.height <= 65536,
            image.width * image.height <= 100_000_000 else { throw CLIError.image }
        let result = Result(revision: VNRecognizeTextRequest.defaultRevision,
            lines: try recognize(image, tiled: image.height > 1024))
        print(String(decoding: try JSONEncoder().encode(result), as: UTF8.self))
    }
} catch {
    FileHandle.standardError.write(Data("vision: cannot process image\n".utf8))
    exit(1)
}
