use tauri::{menu::Menu, menu::MenuItem, tray::TrayIconBuilder, Manager};

fn icon() -> tauri::image::Image<'static> {
    #[cfg(target_os = "macos")]
    return tauri::include_image!("icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    return tauri::include_image!("icons/32x32.png");
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "Show zDeck", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit zDeck", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id("zdeck")
        .icon(icon())
        // macOS uses the alpha mask and adapts the ink to light/dark menu bars.
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.unminimize()
                        .and_then(|_| window.show())
                        .and_then(|_| window.set_focus())
                    {
                        eprintln!("Could not show zDeck: {error}");
                    }
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn tray_icon_has_visible_ink_and_transparent_padding() {
        let icon = super::icon();
        assert!(icon.width() > 0 && icon.height() > 0);
        assert_eq!(icon.rgba().len(), (icon.width() * icon.height() * 4) as usize);
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        #[cfg(target_os = "macos")]
        {
            assert_eq!((icon.width(), icon.height()), (44, 44));
            assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
            assert_eq!(icon.rgba()[3], 0);
        }
    }
}
