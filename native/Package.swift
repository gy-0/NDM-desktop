// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NDMNative",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "NDMHost", targets: ["NDMHost"])],
    targets: [
        .target(name: "NDMCore"),
        .target(name: "NDMEngine", dependencies: ["NDMCore"]),
        .target(name: "NDMBridge", dependencies: ["NDMCore"]),
        .executableTarget(name: "NDMHost", dependencies: ["NDMCore", "NDMEngine", "NDMBridge"]),
        .testTarget(name: "NDMCoreTests", dependencies: ["NDMCore"]),
        .testTarget(name: "NDMEngineTests", dependencies: ["NDMEngine", "NDMCore"]),
        .testTarget(name: "NDMBridgeTests", dependencies: ["NDMBridge", "NDMCore", "NDMEngine"])
    ]
)
