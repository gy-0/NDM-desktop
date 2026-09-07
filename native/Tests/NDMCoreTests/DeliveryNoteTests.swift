import XCTest
@testable import NDMCore

final class DeliveryNoteTests: XCTestCase {
    /// The stored key is a contract with existing databases: changing it silently
    /// turns every recorded note into an unrecognised one.
    func testStorageKeyRoundTrips() {
        XCTAssertEqual(
            DeliveryNote(storageKey: DeliveryNote.audioTrackMissing.storageKey),
            .audioTrackMissing
        )
    }

    func testUnknownOrAbsentKeysDecodeToNothing() {
        XCTAssertNil(DeliveryNote(storageKey: nil))
        XCTAssertNil(DeliveryNote(storageKey: ""))
        XCTAssertNil(DeliveryNote(storageKey: "   "))
        XCTAssertNil(DeliveryNote(storageKey: "note.somethingFromTheFuture"))
    }

    func testSurroundingWhitespaceStillDecodes() {
        XCTAssertEqual(
            DeliveryNote(storageKey: "  note.audioTrackMissing\n"),
            .audioTrackMissing
        )
    }

    /// The user-facing text must not leak implementation vocabulary — no codec
    /// names, no ffmpeg, no stream indices.
    func testTextIsPlainLanguage() {
        for note in [DeliveryNote.audioTrackMissing] {
            let combined = (note.title + " " + note.detail).lowercased()
            for jargon in ["ffmpeg", "mux", "codec", "aac", "stream #", "yt-dlp", "m3u8"] {
                XCTAssertFalse(
                    combined.contains(jargon),
                    "\(note.storageKey) exposes \(jargon.debugDescription) to the user"
                )
            }
            XCTAssertFalse(note.title.isEmpty)
            XCTAssertFalse(note.detail.isEmpty)
        }
    }
}

final class DeliveryNotePersistenceTests: XCTestCase {
    private func makeStore() throws -> (DownloadStore, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-note-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return (try DownloadStore(directory: root), root)
    }

    func testNoteSurvivesInsertAndReload() throws {
        let (store, root) = try makeStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let saved = try store.insert(DownloadTask(
            url: "https://example.com/v",
            filename: "clip.mp4",
            status: .complete,
            deliveryNote: DeliveryNote.audioTrackMissing.storageKey
        ))
        let reloaded = try XCTUnwrap(store.allDownloads().first { $0.id == saved.id })
        XCTAssertEqual(
            DeliveryNote(storageKey: reloaded.deliveryNote),
            .audioTrackMissing
        )
    }

    func testNoteCanBeUpdatedAndCleared() throws {
        let (store, root) = try makeStore()
        defer { try? FileManager.default.removeItem(at: root) }
        var task = try store.insert(DownloadTask(
            url: "https://example.com/v",
            filename: "clip.mp4",
            status: .complete
        ))
        XCTAssertNil(task.deliveryNote, "a clean delivery carries no note")

        task.deliveryNote = DeliveryNote.audioTrackMissing.storageKey
        try store.update(task)
        var reloaded = try XCTUnwrap(store.allDownloads().first { $0.id == task.id })
        XCTAssertEqual(reloaded.deliveryNote, DeliveryNote.audioTrackMissing.storageKey)

        // A retry that succeeds properly must be able to drop the note, or the
        // warning outlives the problem.
        reloaded.deliveryNote = nil
        try store.update(reloaded)
        let cleared = try XCTUnwrap(store.allDownloads().first { $0.id == task.id })
        XCTAssertNil(cleared.deliveryNote)
    }

    /// The column is added by migration, so a database created before it existed
    /// must still open and read back cleanly.
    func testStoreOpensADatabaseCreatedWithoutTheColumn() throws {
        let (store, root) = try makeStore()
        let first = try store.insert(DownloadTask(
            url: "https://example.com/v",
            filename: "clip.mp4",
            status: .complete
        ))
        defer { try? FileManager.default.removeItem(at: root) }

        // Reopening runs migrate() again; it must be idempotent.
        let reopened = try DownloadStore(directory: root)
        let rows = try reopened.allDownloads()
        XCTAssertTrue(rows.contains { $0.id == first.id })
        XCTAssertNil(rows.first { $0.id == first.id }?.deliveryNote)
    }
}
