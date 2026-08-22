import XCTest
@testable import QwenInputCore

final class SafetyGateTests: XCTestCase {
    private func context(
        featureEnabled: Bool = true,
        desktopConnected: Bool = true,
        target: GateSignal = .ready,
        statusVisibility: GateSignal = .ready,
        inputSource: GateSignal = .ready
    ) -> SafetyContext {
        SafetyContext(
            featureEnabled: featureEnabled,
            desktopConnected: desktopConnected,
            target: target,
            statusVisibility: statusVisibility,
            inputSource: inputSource
        )
    }

    func testOnlyCaptureStatesCanCaptureWhenEveryGateIsReady() {
        let gate = SafetyGate(secureEventInputEnabled: { false })
        let states: [(NativeSessionState, SafetyDecision)] = [
            (.disabled, .idle),
            (.ready, .idle),
            (.arming, .idle),
            (.starting, .captureAllowed),
            (.listening, .captureAllowed),
            (.transcribing, .captureAllowed),
            (.paused, .idle),
            (.readyToSend, .idle),
            (.blocked, .idle),
            (.cancelled, .idle),
            (.error, .idle),
        ]

        for (state, expected) in states {
            XCTAssertEqual(
                gate.evaluate(
                    state: state,
                    context: context(),
                    hasOwnedPartial: false
                ),
                expected,
                "unexpected decision for \(state)"
            )
        }
    }

    func testEveryMissingPrerequisiteBlocksCapture() {
        let gate = SafetyGate(secureEventInputEnabled: { false })
        let cases: [(SafetyContext, SafetyBlockReason)] = [
            (context(featureEnabled: false), .featureDisabled),
            (context(desktopConnected: false), .desktopDisconnected),
            (context(target: .unavailable), .targetUnavailable),
            (context(target: .unknown), .targetUnknown),
            (context(statusVisibility: .unavailable), .statusHidden),
            (context(statusVisibility: .unknown), .statusUnknown),
            (context(inputSource: .unavailable), .inputSourceInactive),
            (context(inputSource: .unknown), .inputSourceUnknown),
        ]

        for (context, reason) in cases {
            XCTAssertEqual(
                gate.evaluate(
                    state: .listening,
                    context: context,
                    hasOwnedPartial: false
                ),
                .blocked(reason: reason, removeOwnedPartial: true)
            )
        }
    }

    func testSecureEventInputAlwaysFailsClosed() {
        let gate = SafetyGate(secureEventInputEnabled: { true })

        XCTAssertEqual(
            gate.evaluate(
                state: .starting,
                context: context(),
                hasOwnedPartial: false
            ),
            .blocked(
                reason: .secureEventInput,
                removeOwnedPartial: true
            )
        )
        XCTAssertEqual(
            gate.evaluate(
                state: .paused,
                context: context(),
                hasOwnedPartial: true
            ),
            .blocked(
                reason: .secureEventInput,
                removeOwnedPartial: true
            )
        )
    }

    func testInactiveSessionStillRemovesAnOwnedPartialWhenAGateFails() {
        let gate = SafetyGate(secureEventInputEnabled: { false })

        XCTAssertEqual(
            gate.evaluate(
                state: .paused,
                context: context(desktopConnected: false),
                hasOwnedPartial: true
            ),
            .blocked(
                reason: .desktopDisconnected,
                removeOwnedPartial: true
            )
        )
        XCTAssertEqual(
            gate.evaluate(
                state: .ready,
                context: context(desktopConnected: false),
                hasOwnedPartial: false
            ),
            .blocked(
                reason: .desktopDisconnected,
                removeOwnedPartial: false
            )
        )
    }
}
