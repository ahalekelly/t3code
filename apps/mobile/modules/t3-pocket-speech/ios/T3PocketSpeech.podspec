Pod::Spec.new do |s|
  s.name = 'T3PocketSpeech'
  s.version = '1.0.0'
  s.summary = 'Offline response reading for T3 Code.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3.codes'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'PocketTTSRuntime', '0.4.1.1'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'CryptoKit'
  s.resource_bundles = { 'T3PocketSpeechNotices' => ['../THIRD_PARTY_NOTICES.md'] }
end
