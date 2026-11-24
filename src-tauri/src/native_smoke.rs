// Compiled only for the opt-in native-smoke build, never the normal app.
use std::time::Duration;

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
