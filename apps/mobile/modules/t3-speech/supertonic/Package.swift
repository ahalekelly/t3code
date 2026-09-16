// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "T3Supertonic",
  platforms: [.iOS(.v18), .macOS(.v14)],
  products: [.library(name: "T3Supertonic", targets: ["T3Supertonic"])],
  dependencies: [
    // Pocket already links Rust; Supertonic does not use FluidAudio's NeMo normalizer.
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.7", traits: []),
  ],
  targets: [
    .target(name: "T3Supertonic", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]),
  ]
)
