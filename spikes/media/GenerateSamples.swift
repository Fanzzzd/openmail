import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct Line: Codable {
    let text: String
    let x: Double
    let y: Double
    let size: Double
}
struct Sample: Codable {
    let id: String
    let width: Int
    let height: Int
    let lines: [Line]
    let style: String
}
enum SampleError: Error { case usage, bitmap, png }

func line(_ text: String, _ y: Double, _ size: Double = 28, x: Double = 40) -> Line {
    Line(text: text, x: x, y: y, size: size)
}
func generate(_ sample: Sample, directory: URL) throws {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: sample.width, pixelsHigh: sample.height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: sample.width * 4, bitsPerPixel: 32),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw SampleError.bitmap }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let cg = context.cgContext
    cg.translateBy(x: 0, y: CGFloat(sample.height))
    cg.scaleBy(x: 1, y: -1)
    let dark = sample.style == "code"
    let ticket = sample.style == "ticket"
    let variant = sample.style == "receipt-variant"
    let background = dark ? NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.14, alpha: 1)
        : variant ? NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.88, alpha: 1) : NSColor.white
    cg.setFillColor(background.cgColor)
    cg.fill(CGRect(x: 0, y: 0, width: sample.width, height: sample.height))
    if ticket {
        cg.setFillColor(NSColor(calibratedRed: 0.1, green: 0.3, blue: 0.7, alpha: 1).cgColor)
        cg.fill(CGRect(x: 0, y: 0, width: sample.width, height: 92))
        cg.setStrokeColor(NSColor.gray.cgColor)
        cg.setLineDash(phase: 0, lengths: [10, 8])
        cg.move(to: CGPoint(x: 720, y: 100))
        cg.addLine(to: CGPoint(x: 720, y: 540))
        cg.strokePath()
    }
    if sample.style.hasPrefix("receipt") || ticket {
        cg.setFillColor(NSColor.black.cgColor)
        for n in 0..<100 where n % 3 != 0 {
            cg.fill(CGRect(x: 45 + n * 4, y: sample.height - 130, width: n % 2 + 1, height: 65))
        }
    }
    for item in sample.lines {
        let font = dark ? NSFont.monospacedSystemFont(ofSize: item.size, weight: .regular)
            : NSFont(name: "PingFang SC", size: item.size) ?? NSFont.systemFont(ofSize: item.size)
        let color = ticket && item.y < 92 ? NSColor.white : dark ? NSColor(calibratedRed: 0.8, green: 0.9, blue: 0.9, alpha: 1) : NSColor.black
        let text = NSAttributedString(string: item.text, attributes: [.font: font, .foregroundColor: color])
        // AppKit needs a flipped context to render text in top-left coordinates.
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        text.draw(at: NSPoint(x: item.x, y: item.y))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw SampleError.png }
    try png.write(to: directory.appendingPathComponent(sample.id + ".png"))
}

func run() throws {
    guard CommandLine.arguments.count == 2 else { throw SampleError.usage }
    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let mixed = Sample(id: "mixed", width: 1000, height: 600, lines: [
        line("端侧媒体搜索，邮件内容只在本机处理。", 45, 36),
        line("繁體中文：機票、收據、附件與搜尋。", 120, 32),
        line("OpenMail local media search", 200, 34),
        line("Flight SQ806 departs at 08:30 on 2026-10-01.", 280, 28),
        line("订单编号 A12345，金额 128.50 元。", 360, 28),
        line("Privacy: images stay on this Mac.", 440, 28)
    ], style: "plain")
    var longLines: [Line] = [line("邮件同步记录 / Mail sync log", 25, 26)]
    for i in 0..<112 {
        let text = i % 2 == 0 ? String(format: "记录 %03d：附件已保存，图片索引在本机完成。", i)
            : String(format: "Record %03d: indexed image attachment locally.", i)
        longLines.append(line(text, Double(90 + i * 44), 20))
    }
    let tall = Sample(id: "long", width: 900, height: 5200, lines: longLines, style: "plain")
    let receiptLines = [
        line("CITY MART 城市便利店", 40, 25), line("RECEIPT / 购物小票", 90, 22),
        line("2026-09-30 12:34   No. 008173", 145, 15), line("Cashier: 03   Store: Singapore", 185, 15),
        line("商品 Item              Qty   Amount", 245, 15),
        line("咖啡 Coffee             2     12.00", 290, 15), line("牛奶 Milk               1      4.50", 335, 15),
        line("面包 Bread              3      9.00", 380, 15), line("苹果 Apple              2      6.80", 425, 15),
        line("Subtotal                     32.30", 505, 15), line("Tax GST 9%                    2.91", 550, 15),
        line("TOTAL SGD                    35.21", 620, 22), line("VISA **** 1234", 685, 15),
        line("谢谢惠顾 Thank you!", 760, 18), line("Please keep this receipt.", 815, 15)
    ]
    let receipt = Sample(id: "receipt", width: 600, height: 1100, lines: receiptLines, style: "receipt")
    let variant = Sample(id: "receipt-similar", width: 600, height: 1100, lines: receiptLines, style: "receipt-variant")
    let ticket = Sample(id: "ticket", width: 1000, height: 560, lines: [
        line("AIRLINE BOARDING PASS", 25, 34), line("电子机票 / 登机牌", 120, 28),
        line("SINGAPORE   >   SHANGHAI", 180, 34), line("SIN                 PVG", 240, 36),
        line("PASSENGER: CHEN / MING", 305, 24), line("FLIGHT SQ806   01 OCT 2026", 355, 24),
        line("GATE B12   SEAT 21A   BOARD 08:00", 400, 22),
        line("SQ806", 160, 24, x: 760), line("21A", 230, 32, x: 760)
    ], style: "ticket")
    let code = Sample(id: "code", width: 1100, height: 750, lines: [
        line("media-indexer.ts", 35, 24), line("import { readFile } from 'node:fs/promises';", 110, 24),
        line("export async function indexImage(path: string) {", 160, 24),
        line("  const image = await readFile(path);", 210, 24), line("  const text = await vision.recognize(image);", 260, 24),
        line("  const vector = await embedder.encode(text);", 310, 24), line("  return { text, vector };", 360, 24),
        line("}", 410, 24), line("// Local processing. No image uploads.", 490, 24),
        line("const dimensions = 384;", 540, 24), line("console.log('Index ready');", 590, 24)
    ], style: "code")
    let samples = [mixed, tall, receipt, variant, ticket, code]
    for sample in samples { try generate(sample, directory: directory) }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(samples).write(to: directory.appendingPathComponent("ground-truth.json"))
    print("Generated \(samples.count) PNGs and line-level ground truth.")
}
do { try run() } catch { fputs("generate-samples: \(error)\n", stderr); exit(1) }
