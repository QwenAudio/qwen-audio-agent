import XCTest
@testable import QwenInputCore

final class NativeInputCoreTests: XCTestCase {
    func testProtocolStartsAtVersionOne() {
        XCTAssertEqual(NativeInputCore.protocolVersion, 1)
    }
}

