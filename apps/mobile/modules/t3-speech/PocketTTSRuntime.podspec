Pod::Spec.new do |s|
  s.name = 'PocketTTSRuntime'
  s.version = '0.4.1.2'
  s.summary = 'Pocket TTS CPU inference with Swift bindings.'
  s.homepage = 'https://github.com/UnaMentis/pocket-tts-ios'
  s.author = 'UnaMentis'
  s.license = { :type => 'MIT', :file => 'LICENSE' }
  s.platforms = { :ios => '18.0' }
  s.source = {
    :http => 'https://github.com/ahalekelly/pocket-tts-ios/releases/download/v0.4.1-t3.2/PocketTTSRuntime.zip',
    :sha256 => '074e07d247b946e803ee48ef0ca11a9ca5c61668d192c05f866491a3e87b5036',
  }
  s.static_framework = true
  s.source_files = 'Sources/pocket_tts_ios.swift'
  s.vendored_frameworks = 'PocketTTS.xcframework'
  s.libraries = 'c++'
  s.frameworks = 'Accelerate'
  s.resource_bundles = { 'PocketTTSLicenses' => ['LICENSE', 'THIRD_PARTY_LICENSES.txt'] }
end
