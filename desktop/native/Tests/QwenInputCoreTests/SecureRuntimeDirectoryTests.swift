import Darwin
import Foundation
import XCTest
@testable import QwenInputCore

final class SecureRuntimeDirectoryTests: XCTestCase {
    private var temporaryRoot: URL!

    override func setUpWithError() throws {
        temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("qwen-runtime-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        if let temporaryRoot {
            try? FileManager.default.removeItem(at: temporaryRoot)
            try? FileManager.default.removeItem(
                at: temporaryRoot.appendingPathExtension("real")
            )
        }
    }

    func testCreatesOnlyA0700RuntimeDirectory() throws {
        let directory = SecureRuntimeDirectory(url: temporaryRoot)

        try directory.prepare()

        XCTAssertEqual(try mode(of: temporaryRoot), 0o700)
        XCTAssertEqual(try owner(of: temporaryRoot), geteuid())
        XCTAssertEqual(
            directory.socketURL().lastPathComponent,
            "control.sock"
        )
    }

    func testRejectsSymlinkOrWrongModeRuntimeDirectory() throws {
        let real = temporaryRoot.appendingPathExtension("real")
        try FileManager.default.createDirectory(
            at: real,
            withIntermediateDirectories: true
        )
        try FileManager.default.createSymbolicLink(
            at: temporaryRoot,
            withDestinationURL: real
        )
        XCTAssertThrowsError(try SecureRuntimeDirectory(
            url: temporaryRoot
        ).prepare()) { error in
            XCTAssertEqual(error as? SecureRuntimeDirectoryError, .symbolicLink)
        }

        try FileManager.default.removeItem(at: temporaryRoot)
        try FileManager.default.createDirectory(
            at: temporaryRoot,
            withIntermediateDirectories: true
        )
        XCTAssertEqual(chmod(temporaryRoot.path, 0o755), 0)
        XCTAssertThrowsError(try SecureRuntimeDirectory(
            url: temporaryRoot
        ).prepare()) { error in
            XCTAssertEqual(error as? SecureRuntimeDirectoryError, .unsafeMode)
        }
    }

    private func mode(of url: URL) throws -> mode_t {
        var value = stat()
        guard lstat(url.path, &value) == 0 else { throw POSIXError(.ENOENT) }
        return value.st_mode & 0o777
    }

    private func owner(of url: URL) throws -> uid_t {
        var value = stat()
        guard lstat(url.path, &value) == 0 else { throw POSIXError(.ENOENT) }
        return value.st_uid
    }
}
