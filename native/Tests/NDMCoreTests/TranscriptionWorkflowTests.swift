import XCTest
@testable import NDMCore

final class TranscriptionWorkflowTests: XCTestCase {
    func testSupportsDownloadedAudioAndVideoCaseInsensitively() {
        XCTAssertTrue(TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/interview.MP4")))
        XCTAssertTrue(TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/meeting.m4a")))
        XCTAssertTrue(TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/camera.M2TS")))
    }

    func testRejectsDocumentsAndRemoteURLs() {
        XCTAssertFalse(TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/report.pdf")))
        XCTAssertFalse(TranscriptionWorkflow.supports(fileURL: URL(string: "https://example.com/video.mp4")))
        XCTAssertFalse(TranscriptionWorkflow.supports(fileURL: nil))
    }
}
