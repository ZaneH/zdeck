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
            println!("cargo:rerun-if-changed=windows-app.rc");
            println!("cargo:rerun-if-changed=windows-app.manifest");
            // Tauri's bin-only manifest misses the library and integration test harnesses.
            embed_resource::compile_for_everything("windows-app.rc", embed_resource::NONE)
                .manifest_required()
                .expect("failed to embed the Windows Common Controls v6 manifest");
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
    if target == "windows" {
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run tauri-build");
    } else {
        tauri_build::build();
    }
}
