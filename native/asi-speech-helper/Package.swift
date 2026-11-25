// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "asi-speech-helper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "asi-speech-helper", targets: ["ASISpeechHelper"]),
  ],
  targets: [
    .executableTarget(
      name: "ASISpeechHelper",
      exclude: ["Info.plist"]
    ),
  ]
)
