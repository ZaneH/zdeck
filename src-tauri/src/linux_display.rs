use gtk::prelude::*;

fn fallback_dpi(configured: i32, scale: Option<f64>) -> f64 {
    let dpi = if configured > 0 {
        f64::from(configured) / 1024.0
    } else {
        96.0
    };
    dpi * scale
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0)
}

pub fn initialize() {
    gtk::init().expect("Could not initialize GTK");
    if let Some(screen) = gtk::gdk::Screen::default() {
        if !screen.resolution().is_finite() || screen.resolution() <= 0.0 {
            let configured = gtk::Settings::default()
                .map(|settings| settings.gtk_xft_dpi())
                .unwrap_or(-1);
            let scale = std::env::var("GDK_DPI_SCALE")
                .ok()
                .and_then(|value| value.parse().ok());
            // WebKitGTK 2.52 uses GTK's unset (-1) screen DPI as a negative page zoom.
            screen.set_resolution(fallback_dpi(configured, scale));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fallback_dpi;

    #[test]
    fn unset_dpi_uses_the_gtk_default_and_preserves_valid_scaling() {
        assert_eq!(fallback_dpi(-1, None), 96.0);
        assert_eq!(fallback_dpi(0, None), 96.0);
        assert_eq!(fallback_dpi(147456, None), 144.0);
        assert_eq!(fallback_dpi(98304, Some(1.25)), 120.0);
        for scale in [f64::NAN, f64::INFINITY, -1.0, 0.0] {
            assert_eq!(fallback_dpi(-1, Some(scale)), 96.0);
        }
    }
}
