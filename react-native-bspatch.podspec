require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-bspatch"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = "MIT"
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/BuiHung1612/react-native-bspatch.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}", "cpp/**/*.{h,c,cpp}"
  # iOS links the system libbz2; the bundled bzip2 is for Android only
  s.exclude_files = "cpp/bspatch_jni.cpp", "cpp/bzip2/**"
  s.public_header_files = 'ios/**/*.h'

  s.library = 'bz2'

  s.pod_target_xcconfig = {
    'OTHER_CFLAGS' => '$(inherited) -O3 -flto'
  }

  install_modules_dependencies(s)
end
