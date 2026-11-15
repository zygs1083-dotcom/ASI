// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "asi-sense-helper",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "asi-sense-helper", targets: ["ASISenseHelper"])],
  targets: [
    .target(name: "SenseHelperCore"),
    .executableTarget(name: "ASISenseHelper", dependencies: ["SenseHelperCore"]),
    .testTarget(name: "SenseHelperCoreTests", dependencies: ["SenseHelperCore"]),
  ]
)
