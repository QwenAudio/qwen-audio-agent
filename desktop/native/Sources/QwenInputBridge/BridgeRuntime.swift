import Foundation
import QwenInputCore

enum BridgeRuntimeError: Error {
    case unsupportedDirection(NativeInputMessageType)
}

struct BridgeRuntime {
    let input: FileHandle
    let output: FileHandle

    init(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput
    ) {
        self.input = input
        self.output = output
    }

    func run() throws {
        try write(NativeInputMessage(type: .bridgeReady, state: .ready))
        var decoder = FrameStreamDecoder()

        while true {
            let chunk = input.availableData
            if chunk.isEmpty {
                try decoder.finish()
                return
            }
            do {
                for payload in try decoder.append(chunk) {
                    let request = try FrameCodec.decodePayload(
                        NativeInputMessage.self,
                        from: payload
                    )
                    let response = try response(to: request)
                    try write(response.message)
                    if response.shouldStop { return }
                }
            } catch {
                try? write(NativeInputMessage(
                    type: .bridgeError,
                    state: .error,
                    reason: String(describing: error)
                ))
                throw error
            }
        }
    }

    private func response(
        to request: NativeInputMessage
    ) throws -> (message: NativeInputMessage, shouldStop: Bool) {
        let state: NativeSessionState
        let shouldStop: Bool
        switch request.type {
        case .sessionArm:
            state = .ready
            shouldStop = false
        case .sessionPartial:
            state = .transcribing
            shouldStop = false
        case .sessionFinal:
            state = .readyToSend
            shouldStop = false
        case .sessionCancel:
            state = .cancelled
            shouldStop = false
        case .sessionPause:
            state = .paused
            shouldStop = false
        case .sessionResume:
            state = .listening
            shouldStop = false
        case .bridgeStop:
            state = .disabled
            shouldStop = true
        case .bridgeReady, .sessionState, .bridgeError:
            throw BridgeRuntimeError.unsupportedDirection(request.type)
        }
        return (
            NativeInputMessage(type: .sessionState, state: state),
            shouldStop
        )
    }

    private func write(_ message: NativeInputMessage) throws {
        try output.write(contentsOf: FrameCodec.encode(message))
    }
}
