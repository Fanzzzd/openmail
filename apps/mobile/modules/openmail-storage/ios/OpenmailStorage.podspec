Pod::Spec.new do |s|
  s.name = 'OpenmailStorage'
  s.version = '0.1.0'
  s.summary = 'Exclude persistent openmail data from device backups'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'openmail'
  s.homepage = 'https://github.com/Fanzzzd/openmail'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/Fanzzzd/openmail.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
