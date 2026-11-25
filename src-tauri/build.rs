fn main() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    match target.as_str() {
        "macos" => {
            println!("cargo:rerun-if-changed=native/system_macos.m");
            println!("cargo:rerun-if-changed=native/system.h");
            cc::Build::new()
                .file("native/system_macos.m")
                .flag("-fobjc-arc")
                .compile("zdeck_system");
            for framework in ["CoreAudio", "Foundation", "AppKit", "ApplicationServices"] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
        }
        "windows" => {
            println!("cargo:rerun-if-changed=native/system_windows.cpp");
            println!("cargo:rerun-if-changed=native/system.h");
            cc::Build::new()
                .cpp(true)
                .file("native/system_windows.cpp")
                .compile("zdeck_system");
            for library in ["ole32", "uuid", "user32"] {
                println!("cargo:rustc-link-lib={library}");
            }
        }
        _ => (),
    }
    tauri_build::build()
}
