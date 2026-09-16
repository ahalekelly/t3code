Pod::Spec.new do |s|
  s.name = 'T3Speech'
  s.version = '1.0.0'
  s.summary = 'Offline response reading for T3 Code.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3.codes'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'PocketTTSRuntime', '0.4.1.2'
  spm_dependency(s,
    url: File.expand_path('../supertonic', __dir__),
    requirement: nil,
    products: ['T3Supertonic'])
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'CryptoKit'
  s.resource_bundles = { 'T3SpeechNotices' => ['../THIRD_PARTY_NOTICES.md', '../FluidAudio-LICENSE', '../Supertonic-LICENSE'] }
end
