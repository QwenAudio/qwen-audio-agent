import AppKit
import InputMethodKit
import QwenInputCore

guard
    let connectionName = Bundle.main.object(
        forInfoDictionaryKey: "InputMethodConnectionName"
    ) as? String,
    let bundleIdentifier = Bundle.main.bundleIdentifier
else {
    exit(EXIT_FAILURE)
}

_ = NativeInputCore.protocolVersion
let server = IMKServer(
    name: connectionName,
    bundleIdentifier: bundleIdentifier
)
withExtendedLifetime(server) {
    RunLoop.main.run()
}

