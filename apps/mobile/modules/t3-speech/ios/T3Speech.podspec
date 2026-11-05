Pod::Spec.new do |s|
  s.name = 'T3Speech'
  s.version = '1.0.0'
  s.summary = 'Reads T3 Code responses aloud.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3.codes'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'MediaPlayer'
end
