Pod::Spec.new do |s|
  s.name = 'PocketTTSRuntime'
  s.version = '0.4.1.1'
  s.summary = 'Pocket TTS CPU inference with Swift bindings.'
  s.homepage = 'https://github.com/UnaMentis/pocket-tts-ios'
  s.author = 'UnaMentis'
  s.license = { :type => 'MIT', :file => 'LICENSE' }
  s.platforms = { :ios => '18.0' }
  s.source = {
    :http => 'https://github.com/ahalekelly/pocket-tts-ios/releases/download/v0.4.1-t3.1/PocketTTSRuntime.zip',
    :sha256 => '8b5b8c5b9941ae4322334106c22b2e7d054ae9584b62ddd16a1a66343d8f36a8',
  }
  s.static_framework = true
  s.source_files = 'Sources/pocket_tts_ios.swift'
  s.vendored_frameworks = 'PocketTTS.xcframework'
  s.libraries = 'c++'
  s.frameworks = 'Accelerate'
  s.resource_bundles = { 'PocketTTSLicenses' => ['LICENSE', 'THIRD_PARTY_LICENSES.txt'] }
end
