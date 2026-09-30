import Foundation
import Vision
import ImageIO

struct TextLine: Codable {
    let text: String
    let confidence: Float
    // Pixels in the original image, top-left origin.
    let box: [Double]
}

enum CLIError: Error { case usage, image, crop }

func load(_ path: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw CLIError.image }
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
                box: [b.minX * Double(image.width), y, b.width * Double(image.width), boxHeight]))
        }
    }
    return lines.sorted {
        if abs($0.box[1] - $1.box[1]) > min($0.box[3], $1.box[3]) / 2 { return $0.box[1] < $1.box[1] }
        return $0.box[0] < $1.box[0]
    }
}

func json(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}

func run() throws {
    var args = Array(CommandLine.arguments.dropFirst())
    let tiled = args.contains("--tile")
    args.removeAll { $0 == "--tile" }
    var repeats = 1
    if let i = args.firstIndex(of: "--repeat") {
        guard i + 1 < args.count, let n = Int(args[i + 1]), n > 0 else { throw CLIError.usage }
        repeats = n
        args.removeSubrange(i...i + 1)
    }
    guard !args.isEmpty else { throw CLIError.usage }
    if args[0] == "classify" {
        guard args.count == 2 else { throw CLIError.usage }
        let image = try load(args[1])
        var times: [Double] = []
        var labels: [[String: Any]] = []
        for _ in 0..<repeats {
            let start = DispatchTime.now().uptimeNanoseconds
            let request = VNClassifyImageRequest()
            try VNImageRequestHandler(cgImage: image).perform([request])
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
            labels = (request.results ?? []).prefix(5).map { ["label": $0.identifier, "confidence": $0.confidence] }
        }
        print(try json(["labels": labels, "ms": times]))
    } else if args[0] == "feature" {
        guard args.count >= 3 else { throw CLIError.usage }
        var prints: [VNFeaturePrintObservation] = []
        var times: [Double] = []
        for path in args.dropFirst() {
            let image = try load(path)
            let start = DispatchTime.now().uptimeNanoseconds
            let request = VNGenerateImageFeaturePrintRequest()
            try VNImageRequestHandler(cgImage: image).perform([request])
            guard let observation = request.results?.first as? VNFeaturePrintObservation else { throw CLIError.image }
            prints.append(observation)
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
        }
        var distances: [Float] = []
        for target in prints.dropFirst() {
            var distance: Float = 0
            try prints[0].computeDistance(&distance, to: target)
            distances.append(distance)
        }
        print(try json(["ms": times, "distances_from_first": distances, "revision": VNGenerateImageFeaturePrintRequest.defaultRevision,
            "element_count": prints[0].elementCount]))
    } else {
        guard args.count == 1 else { throw CLIError.usage }
        let startDecode = DispatchTime.now().uptimeNanoseconds
        let image = try load(args[0])
        let decodeMs = Double(DispatchTime.now().uptimeNanoseconds - startDecode) / 1e6
        var times: [Double] = []
        var lines: [TextLine] = []
        for _ in 0..<repeats {
            let start = DispatchTime.now().uptimeNanoseconds
            lines = try recognize(image, tiled: tiled)
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for line in lines { print(String(decoding: try encoder.encode(line), as: UTF8.self)) }
        let summary = try json(["ms": times, "decode_ms": decodeMs, "width": image.width, "height": image.height,
            "tile_height": tiled ? 1024 : image.height, "overlap": tiled ? 128 : 0,
            "revision": VNRecognizeTextRequest.defaultRevision])
        FileHandle.standardError.write(Data((summary + "\n").utf8))
    }
}

do { try run() } catch {
    FileHandle.standardError.write(Data("vision: \(error). Usage: vision [--tile] [--repeat N] IMAGE | classify IMAGE | feature IMAGE IMAGE...\n".utf8))
    exit(1)
}
