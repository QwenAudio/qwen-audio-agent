import Foundation
import XCTest
@testable import QwenInputCore

final class FrameCodecTests: XCTestCase {
    private func message(
        _ type: NativeInputMessageType = .sessionPartial,
        text: String? = "你好"
    ) -> NativeInputMessage {
        NativeInputMessage(type: type, text: text)
    }

    func testRoundTripUsesFourByteBigEndianLength() throws {
        let frame = try FrameCodec.encode(message())
        let declared = frame.prefix(4).reduce(UInt32(0)) {
            ($0 << 8) | UInt32($1)
        }

        XCTAssertEqual(Int(declared), frame.count - 4)
        XCTAssertEqual(
            try FrameCodec.decode(NativeInputMessage.self, from: frame),
            message()
        )
    }

    func testIncrementalDecoderHandlesSplitAndCoalescedFrames() throws {
        let first = try FrameCodec.encode(message(.sessionPartial, text: "a"))
        let second = try FrameCodec.encode(message(.sessionFinal, text: "b"))
        let stream = first + second
        var decoder = FrameStreamDecoder()

        XCTAssertEqual(try decoder.append(stream.prefix(3)), [])
        let frames = try decoder.append(stream.dropFirst(3))

        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(
            try FrameCodec.decodePayload(NativeInputMessage.self, from: frames[0]),
            message(.sessionPartial, text: "a")
        )
        XCTAssertEqual(
            try FrameCodec.decodePayload(NativeInputMessage.self, from: frames[1]),
            message(.sessionFinal, text: "b")
        )
        XCTAssertNoThrow(try decoder.finish())
    }

    func testRejectsZeroOversizedTruncatedAndTrailingFrames() throws {
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: Data([0, 0, 0, 0])
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .zeroLength)
        }

        let tooLarge = UInt32(FrameCodec.maximumPayloadBytes + 1)
        let oversizedHeader = Data([
            UInt8((tooLarge >> 24) & 0xff),
            UInt8((tooLarge >> 16) & 0xff),
            UInt8((tooLarge >> 8) & 0xff),
            UInt8(tooLarge & 0xff),
        ])
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: oversizedHeader
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .oversized)
        }

        let valid = try FrameCodec.encode(message())
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: valid.dropLast()
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .truncated)
        }
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: valid + Data([0])
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .trailingBytes)
        }
    }

    func testRejectsInvalidUTF8JSONAndUnknownMessageType() {
        let invalidUTF8 = framed(Data([0xff]))
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: invalidUTF8
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .invalidUTF8)
        }

        let invalidJSON = framed(Data("{".utf8))
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: invalidJSON
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .invalidJSON)
        }

        let unknown = framed(Data(#"{"type":"session.unknown"}"#.utf8))
        XCTAssertThrowsError(try FrameCodec.decode(
            NativeInputMessage.self,
            from: unknown
        )) { error in
            XCTAssertEqual(error as? FrameCodecError, .invalidJSON)
        }
    }

    func testFinishRejectsTruncatedBufferedFrame() throws {
        let frame = try FrameCodec.encode(message())
        var decoder = FrameStreamDecoder()
        _ = try decoder.append(frame.dropLast())

        XCTAssertThrowsError(try decoder.finish()) { error in
            XCTAssertEqual(error as? FrameCodecError, .truncated)
        }
    }

    private func framed(_ payload: Data) -> Data {
        let length = UInt32(payload.count)
        return Data([
            UInt8((length >> 24) & 0xff),
            UInt8((length >> 16) & 0xff),
            UInt8((length >> 8) & 0xff),
            UInt8(length & 0xff),
        ]) + payload
    }
}
