// Compiled only for the opt-in native-smoke build, never the normal app.
use std::time::Duration;
use tauri::Manager;

pub struct IsolatedData(pub tempfile::TempDir);

// Exact candidate under review; defaults retain the published Home Assistant pilot.
fn smoke_target() -> (String, String) {
    (
        std::env::var("ZDECK_SMOKE_ID").unwrap_or_else(|_| "home-assistant".into()),
        std::env::var("ZDECK_SMOKE_VERSION").unwrap_or_else(|_| "0.2.0".into()),
    )
}

// Feature-only native delivery hook, never renderer IPC or an OS association rewrite.
pub fn registry_delivery(app: &tauri::AppHandle) {
    match std::env::var("ZDECK_REGISTRY_SMOKE").as_deref() {
        Ok("local") => crate::plugin_archive::drop_paths(app, vec![std::env::var_os("ZDECK_SMOKE_ARCHIVE").expect("explicit smoke archive").into()]),
        Ok("remote" | "missing") => {
            let (id, version) = smoke_target();
            crate::plugin_archive::request_link(app, &format!("zdeck://plugins/install?id={id}&version={version}"));
        }
        Ok(_) => panic!("Use local, remote or missing registry smoke mode"),
        Err(_) => (),
    }
}

pub fn check_registry(webview: tauri::Webview) {
    println!("ZDECK_SMOKE_ORIGIN {} {}", webview.label(), webview.url().expect("bundled origin"));
    let missing = std::env::var("ZDECK_REGISTRY_SMOKE").as_deref() == Ok("missing");
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let (id, version) = smoke_target();
        let script = include_str!("registry-smoke.js")
            .replace("EXPECTED_MISSING", if missing { "true" } else { "false" })
            .replace("EXPECTED_ID", &id)
            .replace("EXPECTED_VERSION", &version);
        webview.eval(script).expect("start registry smoke in bundled WebKit");
        for _ in 0..90 {
            std::thread::sleep(Duration::from_secs(1));
            let handle = webview.app_handle().clone();
            webview.eval_with_callback("window.__zdeckRegistrySmoke || null", move |result| {
                if result != "null" && !result.is_empty() {
                    println!("ZDECK_REGISTRY_SMOKE {result}");
                    crate::tray::quit(&handle);
                }
            }).expect("poll registry smoke");
        }
    });
}

pub fn check_layout(webview: tauri::Webview) {
    std::thread::spawn(move || {
        for step in ["welcome", "build", "try", "editor", "settings"] {
            std::thread::sleep(Duration::from_millis(700));
            let script = format!(
                r#"(() => {{
                const box = selector => {{
                    const element = document.querySelector(selector);
                    if (!element) return null;
                    const rect = element.getBoundingClientRect();
                    return {{ width: rect.width, height: rect.height, x: rect.x, y: rect.y }};
                }};
                const report = {{ step: '{step}', width: innerWidth, height: innerHeight,
                    dpr: devicePixelRatio, font: parseFloat(getComputedStyle(document.documentElement).fontSize),
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    story: box('.setup-story'), heading: box('#setup-title'),
                    key: box('.setup-demo-key, .setup-choice, .setup-practice-key'),
                    workspace: box('.workspace'), grid: box('.control-grid'), inspector: box('.inspector-dock'),
                    disclosures: [...document.querySelectorAll('.settings-view .disclosure')].map(element => {{
                        const rect = element.getBoundingClientRect();
                        const text = document.createRange();
                        text.selectNodeContents(element);
                        const label = text.getBoundingClientRect();
                        const arrow = getComputedStyle(element, '::before');
                        return {{ x: rect.x, height: rect.height,
                            labelOffset: label.y + label.height / 2 - rect.y - rect.height / 2,
                            arrow: arrow.borderRightStyle,
                            closedGap: element.parentElement.getBoundingClientRect().bottom - rect.bottom }};
                    }}),
                    steps: [...document.querySelectorAll('.remote-steps > li')].map(element => {{
                        const rect = element.getBoundingClientRect();
                        const text = document.createRange();
                        text.selectNodeContents(element);
                        const label = text.getBoundingClientRect();
                        return {{ labelOffset: label.y + label.height / 2 - rect.y - rect.height / 2,
                            circle: getComputedStyle(element, '::before').borderRadius }};
                    }}) }};
                // Navigation only; no rehearsal, native action, or service controls.
                if ('{step}' === 'welcome') document.querySelector('.setup-actions button')?.click();
                if ('{step}' === 'build') document.querySelector('.setup-story form')?.requestSubmit();
                if ('{step}' === 'try') document.querySelector('.setup-header button')?.click();
                if ('{step}' === 'editor') location.hash = '#/settings';
                return report;
            }})()"#
            );
            if let Err(error) = webview.eval_with_callback(script, |result| {
                println!("ZDECK_NATIVE_LAYOUT {result}");
            }) {
                eprintln!("Could not inspect native layout: {error}");
                break;
            }
        }
    });
}
