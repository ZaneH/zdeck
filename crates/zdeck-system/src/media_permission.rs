//! Desktop-only setup; deliberately not part of ControlAction or remote routing.
use super::SystemError;
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaPlatform { Macos, Windows, Linux, Unsupported }

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaPermissionStatus { Granted, Required, NotRequired, Unsupported }

#[derive(Debug, Serialize)]
pub struct MediaPermission {
    pub platform: MediaPlatform,
    pub status: MediaPermissionStatus,
}

fn permission(platform: MediaPlatform, trusted: bool) -> MediaPermission {
    let status = match platform {
        MediaPlatform::Macos if trusted => MediaPermissionStatus::Granted,
        MediaPlatform::Macos => MediaPermissionStatus::Required,
        MediaPlatform::Windows | MediaPlatform::Linux => MediaPermissionStatus::NotRequired,
        MediaPlatform::Unsupported => MediaPermissionStatus::Unsupported,
    };
    MediaPermission { platform, status }
}

pub fn status() -> MediaPermission {
    #[cfg(target_os = "macos")]
    {
        extern "C" { fn zdeck_media_permission_status() -> i32; }
        // SAFETY: observational Accessibility query only; never prompts or sends media.
        permission(MediaPlatform::Macos, unsafe { zdeck_media_permission_status() } == 1)
    }
    #[cfg(target_os = "windows")]
    { permission(MediaPlatform::Windows, false) }
    #[cfg(target_os = "linux")]
    { permission(MediaPlatform::Linux, false) }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    { permission(MediaPlatform::Unsupported, false) }
}

/// Caller must dispatch on the main thread, from explicit desktop setup action only.
pub fn request() -> Result<MediaPermission, SystemError> {
    #[cfg(target_os = "macos")]
    {
        extern "C" { fn zdeck_media_permission_request() -> i32; }
        // SAFETY: fixed operation with no external arguments; caller uses AppKit main thread.
        if unsafe { zdeck_media_permission_request() } < 0 {
            return Err(SystemError::command_failed(
                "Could not open System Settings. Open Privacy & Security → Accessibility and enable zDeck manually.",
            ));
        }
    }
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn platform_status_is_explicit() {
        for (platform, trusted, expected) in [
            (MediaPlatform::Macos, false, MediaPermissionStatus::Required),
            (MediaPlatform::Macos, true, MediaPermissionStatus::Granted),
            (MediaPlatform::Windows, false, MediaPermissionStatus::NotRequired),
            (MediaPlatform::Linux, false, MediaPermissionStatus::NotRequired),
            (MediaPlatform::Unsupported, false, MediaPermissionStatus::Unsupported),
        ] {
            assert_eq!(permission(platform, trusted).status, expected);
        }
    }
}
