// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "QwenAudioAgentMobile",
    platforms: [
        .iOS(.v17),
        .macOS(.v13),
    ],
    products: [
        .library(name: "QwenAudioAgentMobile", targets: ["QwenAudioAgentMobile"]),
    ],
    targets: [
        .target(
            name: "QwenAudioAgentMobile",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .testTarget(
            name: "QwenAudioAgentMobileTests",
            dependencies: ["QwenAudioAgentMobile"]
        ),
    ]
)
