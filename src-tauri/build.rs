fn main() {
    println!("cargo:rerun-if-env-changed=ZDECK_REGISTRY_WEBSITE_URL");
    println!("cargo:rerun-if-env-changed=ZDECK_REGISTRY_RELEASE_URL");
    println!("cargo:rerun-if-env-changed=ZDECK_REGISTRY_PUBLIC_KEYS");
    println!("cargo:rerun-if-changed=registry-public-keys.json");
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    if target == "windows" {
        println!("cargo:rerun-if-changed=windows-app.rc");
        println!("cargo:rerun-if-changed=windows-app.manifest");
        // Tauri's bin-only manifest misses the library and integration test harnesses.
        embed_resource::compile_for_everything("windows-app.rc", embed_resource::NONE)
            .manifest_required()
            .expect("failed to embed the Windows Common Controls v6 manifest");
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run tauri-build");
    } else {
        tauri_build::build();
    }
}
