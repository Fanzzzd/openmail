import Foundation
import Contacts
import AddressBook

// Only --request may ask for access. All other modes check authorization first.
enum Mode: String { case status = "--status", request = "--request", read = "--read", selfTest = "--self-test" }
func status() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    default: return CNContactStore.authorizationStatus(for: .contacts).rawValue == 4 ? "limited" : "restricted"
    }
}
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func preferredEmail(_ emails: [String], _ preferred: String?) -> String {
    if let preferred = preferred, let email = emails.first(where: { $0.caseInsensitiveCompare(preferred) == .orderedSame }) { return email }
    return emails.first ?? ""
}
func legacyRecord(_ book: ABAddressBook?, _ id: String, _ suffix: String) -> ABRecord? {
    return book?.record(forUniqueId: id) ?? book?.record(forUniqueId: id + suffix)
}
func distributionEmail(_ book: ABAddressBook?, _ group: CNGroup, _ contact: CNContact) -> String {
    let emails = contact.emailAddresses.map { $0.value as String }
    // CNContactStore has no distribution-list address API. Use the public legacy
    // read API only after full CN authorization; never use it for limited access.
    guard let person = legacyRecord(book, contact.identifier, ":ABPerson") as? ABPerson,
          let values = person.value(forProperty: kABEmailProperty) as? ABMultiValue else { return preferredEmail(emails, nil) }
    let legacyGroup = legacyRecord(book, group.identifier, ":ABGroup") as? ABGroup
    let identifiers = [legacyGroup?.distributionIdentifier(forProperty: kABEmailProperty, person: person), values.primaryIdentifier()]
    for identifier in identifiers.compactMap({ $0 }) {
        let index = values.index(forIdentifier: identifier)
        if index < values.count(), let value = values.value(at: index) as? String,
           let email = emails.first(where: { $0.caseInsensitiveCompare(value) == .orderedSame }) { return email }
    }
    return preferredEmail(emails, nil)
}
func readContacts(photos: Bool) throws -> [String: Any] {
    let authorization = status()
    guard authorization == "authorized" || authorization == "limited" else { return ["status": authorization] }
    let store = CNContactStore()
    var keys: [CNKeyDescriptor] = [CNContactIdentifierKey as CNKeyDescriptor,
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactEmailAddressesKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor]
    if photos { keys.append(CNContactThumbnailImageDataKey as CNKeyDescriptor) }
    var contacts: [[String: Any]] = []
    var thumbnailBytes = 0
    try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { contact, _ in
        let emails = contact.emailAddresses.map { $0.value as String }
        guard !emails.isEmpty else { return }
        var thumbnail: Any = NSNull()
        if photos, let data = contact.thumbnailImageData, data.count <= 256 * 1024, thumbnailBytes + data.count <= 8 * 1024 * 1024 {
            let prefix = [UInt8](data.prefix(8))
            let mime = prefix.starts(with: [0xff, 0xd8, 0xff]) ? "jpeg" : prefix.starts(with: [0x89, 0x50, 0x4e, 0x47]) ? "png" : ""
            if !mime.isEmpty { thumbnailBytes += data.count; thumbnail = "data:image/\(mime);base64,\(data.base64EncodedString())" }
        }
        contacts.append(["id": contact.identifier, "name": CNContactFormatter.string(from: contact, style: .fullName) ?? "",
                         "company": contact.organizationName, "emails": emails, "thumbnail": thumbnail])
    }
    let book = authorization == "authorized" ? ABAddressBook.shared() : nil
    let memberKeys: [CNKeyDescriptor] = [CNContactIdentifierKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor]
    let groups = try store.groups(matching: nil).map { group -> [String: Any] in
        let members = try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: group.identifier), keysToFetch: memberKeys)
        return ["id": group.identifier, "name": group.name, "members": members.map { contact in
            ["id": contact.identifier, "address": distributionEmail(book, group, contact)]
        }]
    }
    // Discard a snapshot if permission changed while the fetch was running.
    guard status() == authorization else { return ["status": status()] }
    return ["status": authorization, "contacts": contacts, "groups": groups]
}
let arguments = Array(CommandLine.arguments.dropFirst())
guard let first = arguments.first, let mode = Mode(rawValue: first),
      arguments.count == 1 || (mode == .read && arguments == ["--read", "--photos"]) else {
    try? emit(["status": "error"])
    exit(2)
}
do {
    switch mode {
    case .status: try emit(["status": status()])
    case .selfTest:
        precondition(preferredEmail(["first@example.com", "work@example.com"], "WORK@example.com") == "work@example.com")
        precondition(preferredEmail(["first@example.com"], "missing@example.com") == "first@example.com")
        precondition(preferredEmail([], nil) == "")
        try emit(["status": status()]) // No store instance, request, enumeration or legacy access.
    case .request:
        if status() == "notDetermined" {
            let store = CNContactStore()
            store.requestAccess(for: .contacts) { _, _ in
                try? emit(["status": status()])
                exit(0)
            }
            dispatchMain()
        }
        try emit(["status": status()])
    case .read: try emit(readContacts(photos: arguments.contains("--photos")))
    }
} catch {
    // Do not expose OS errors containing contact data to app logs.
    try? emit(["status": "error"])
    exit(1)
}
