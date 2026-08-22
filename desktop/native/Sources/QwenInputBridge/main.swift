import Foundation
import QwenInputCore

do {
    try BridgeRuntime().run()
} catch {
    exit(EXIT_FAILURE)
}
