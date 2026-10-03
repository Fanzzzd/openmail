import AppKit

struct Issue: Encodable { let start: Int; let end: Int; let description: String; let suggestions: [String] }
func appendDetails(_ details: NSArray, sentence: NSRange, issues: inout [Issue]) {
    for case let detail as [String: Any] in details {
        guard issues.count < 256 else { break }
        guard let range = detail[NSGrammarRange] as? NSValue,
              let description = detail[NSGrammarUserDescription] as? String else { continue }
        let local = range.rangeValue
        let start = sentence.location + local.location
        let end = start + local.length
        guard local.location != NSNotFound, local.length > 0, start >= sentence.location,
              end <= NSMaxRange(sentence) else { continue }
        issues.append(Issue(start: start, end: end, description: description,
            suggestions: Array((detail[NSGrammarCorrections] as? [String] ?? []).prefix(16))))
    }
}
func check(_ text: String) -> [Issue] {
    let checker = NSSpellChecker.shared
    let tag = NSSpellChecker.uniqueSpellDocumentTag()
    defer { checker.closeSpellDocument(withTag: tag) }
    let length = (text as NSString).length
    var offset = 0
    var issues: [Issue] = []
    while offset < length && issues.count < 256 {
        var details: NSArray?
        let sentence = checker.checkGrammar(of: text, startingAt: offset, language: nil,
            wrap: false, inSpellDocumentWithTag: tag, details: &details)
        guard sentence.location != NSNotFound, sentence.length > 0,
              NSMaxRange(sentence) <= length, NSMaxRange(sentence) > offset else { break }
        appendDetails(details ?? [], sentence: sentence, issues: &issues)
        offset = NSMaxRange(sentence)
    }
    return issues
}
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments == ["--check"] || arguments == ["--self-test"] else { exit(2) }
// --self-test exercises the real checker, with no app session, UI or permissions.
let data = arguments == ["--self-test"] ? Data("He are going to school. 😀 This are a test.".utf8) : FileHandle.standardInput.readDataToEndOfFile()
guard data.count <= 400_000, let text = String(data: data, encoding: .utf8), (text as NSString).length <= 100_000 else { exit(2) }
let issues = check(text)
if arguments == ["--self-test"] {
    precondition(check("").isEmpty)
    let detail: [String: Any] = [NSGrammarRange: NSValue(range: NSRange(location: 0, length: 1)),
        NSGrammarUserDescription: "Synthetic grammar", NSGrammarCorrections: ["a"]]
    var overflow: [Issue] = []
    appendDetails(NSArray(array: Array(repeating: detail, count: 300)), sentence: NSRange(location: 0, length: 1), issues: &overflow)
    precondition(overflow.count == 256)
    precondition(issues.allSatisfy { $0.start >= 0 && $0.end <= (text as NSString).length })
}
guard let output = try? JSONEncoder().encode(issues) else { exit(1) }
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([10]))
