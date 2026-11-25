#include "system.h"
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <IOKit/hidsystem/ev_keymap.h>
#include <IOKit/hidsystem/IOLLEvent.h>
#include <math.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>

#ifndef ZDECK_PREFS_SUITE
#define ZDECK_PREFS_SUITE @"app.zdeck.system-controls"
#endif

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector,
                                         AudioObjectPropertyScope scope, UInt32 element) {
    return (AudioObjectPropertyAddress){selector, scope, element};
}
static BOOL read_property(AudioObjectID device, AudioObjectPropertyAddress prop,
                          void *value, UInt32 size) {
    UInt32 actual = size;
    return AudioObjectGetPropertyData(device, &prop, 0, NULL, &actual, value) == noErr
        && actual == size;
}
static BOOL write_property(AudioObjectID device, AudioObjectPropertyAddress prop,
                           const void *value, UInt32 size) {
    return AudioObjectSetPropertyData(device, &prop, 0, NULL, size, value) == noErr;
}
static BOOL usable(AudioObjectID device, AudioObjectPropertyAddress prop, BOOL writing) {
    if (!AudioObjectHasProperty(device, &prop)) return NO;
    Boolean settable = false;
    return !writing || (AudioObjectIsPropertySettable(device, &prop, &settable) == noErr && settable);
}
static UInt32 channel_count(AudioObjectID device, AudioObjectPropertyScope scope) {
    AudioObjectPropertyAddress prop = address(kAudioDevicePropertyStreamConfiguration, scope, 0);
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(device, &prop, 0, NULL, &size) != noErr ||
        size < sizeof(AudioBufferList)) return 0;
    AudioBufferList *buffers = calloc(1, size);
    if (!buffers) return 0;
    UInt32 channels = 0;
    if (AudioObjectGetPropertyData(device, &prop, 0, NULL, &size, buffers) == noErr) {
        for (UInt32 i = 0; i < buffers->mNumberBuffers; i++) channels += buffers->mBuffers[i].mNumberChannels;
    }
    free(buffers);
    return channels <= 256 ? channels : 0;
}
// Prefer the main control; otherwise require a control on EVERY channel.
static NSArray<NSNumber *> *elements(AudioObjectID device, AudioObjectPropertyScope scope,
                                     AudioObjectPropertySelector selector, BOOL writing) {
    if (usable(device, address(selector, scope, 0), writing)) return @[@0];
    UInt32 count = channel_count(device, scope);
    if (!count) return nil;
    NSMutableArray *result = [NSMutableArray array];
    for (UInt32 i = 1; i <= count; i++) {
        if (!usable(device, address(selector, scope, i), writing)) return nil;
        [result addObject:@(i)];
    }
    return result;
}
static NSArray<NSNumber *> *levels(AudioObjectID device, AudioObjectPropertyScope scope,
                                   NSArray<NSNumber *> *channels) {
    NSMutableArray *result = [NSMutableArray array];
    for (NSNumber *channel in channels) {
        Float32 level = 0;
        if (!read_property(device, address(kAudioDevicePropertyVolumeScalar, scope, channel.unsignedIntValue),
                           &level, sizeof(level)) || !isfinite(level) || level < 0 || level > 1) return nil;
        [result addObject:@(level)];
    }
    return result;
}
static BOOL all_zero(NSArray<NSNumber *> *values) {
    for (NSNumber *value in values) if (value.floatValue != 0) return NO;
    return values.count > 0;
}
static BOOL valid_saved(id saved, NSArray<NSNumber *> *channels) {
    if (![saved isKindOfClass:NSDictionary.class] || ![saved[@"version"] isEqual:@1] ||
        ![saved[@"elements"] isEqual:channels] || ![saved[@"levels"] isKindOfClass:NSArray.class] ||
        [saved[@"levels"] count] != channels.count || !channels.count) return NO;
    for (id level in saved[@"levels"]) {
        if (![level isKindOfClass:NSNumber.class] || !isfinite([level doubleValue]) ||
            [level doubleValue] < 0 || [level doubleValue] > 1) return NO;
    }
    return YES;
}
// A failed multi-channel mute can leave some channels at zero. Keep the original
// record on the next mute/unmute, rather than saving that partial state as the baseline.
static BOOL matches_saved_or_zero(NSArray<NSNumber *> *current, id saved, NSArray<NSNumber *> *channels) {
    if (!valid_saved(saved, channels)) return NO;
    NSArray<NSNumber *> *original = saved[@"levels"];
    for (NSUInteger i = 0; i < current.count; i++) {
        if (current[i].floatValue != 0 && fabs(current[i].doubleValue - original[i].doubleValue) > 0.0001) return NO;
    }
    return YES;
}
static BOOL apply_levels(AudioObjectID device, AudioObjectPropertyScope scope,
                          NSArray<NSNumber *> *channels, NSArray<NSNumber *> *values) {
    for (NSUInteger i = 0; i < channels.count; i++) {
        Float32 level = values[i].floatValue;
        if (!write_property(device, address(kAudioDevicePropertyVolumeScalar, scope, channels[i].unsignedIntValue),
                            &level, sizeof(level))) return NO;
    }
    return YES;
}
static BOOL same_levels(NSArray<NSNumber *> *actual, NSArray<NSNumber *> *expected) {
    if (!actual || actual.count != expected.count) return NO;
    for (NSUInteger i = 0; i < actual.count; i++) {
        if (fabs(actual[i].doubleValue - expected[i].doubleValue) > 0.0001) return NO;
    }
    return YES;
}

// Devices without mute controls use a durable, per-UID, per-channel restore record.
// Never erase that record until every restored level has been read back.
static int volume_mute(AudioObjectID device, BOOL writing, BOOL mute, BOOL *muted) {
    AudioObjectPropertyScope scope = kAudioDevicePropertyScopeInput;
    NSArray *channels = elements(device, scope, kAudioDevicePropertyVolumeScalar, YES);
    if (!channels) return ZNoControl;
    NSArray *current = levels(device, scope, channels);
    if (!current) return ZNoControl;
    *muted = all_zero(current);
    if (!writing) return ZOk;

    CFStringRef uid = NULL;
    if (!read_property(device, address(kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, 0),
                       &uid, sizeof(uid)) || !uid) return ZPersistence;
    NSString *key = CFBridgingRelease(uid);
    NSUserDefaults *store = [[NSUserDefaults alloc] initWithSuiteName:ZDECK_PREFS_SUITE];
    if (!store || ![store synchronize]) return ZPersistence;
    id saved = [store objectForKey:key];
    if (mute) {
        if (*muted) return ZOk; // An existing restore record must not be replaced with zeros.
        if (!matches_saved_or_zero(current, saved, channels)) {
            saved = @{@"version": @1, @"elements": channels, @"levels": current};
            [store setObject:saved forKey:key];
            if (![store synchronize]) return ZPersistence; // No audio writes before durable storage.
        }
        NSMutableArray *zeros = [NSMutableArray array];
        for (NSUInteger i = 0; i < channels.count; i++) [zeros addObject:@0];
        if (!apply_levels(device, scope, channels, zeros)) return ZUnknown;
        NSArray *after = levels(device, scope, channels);
        if (!after) return ZUnknown;
        *muted = all_zero(after);
        return ZOk;
    }
    if (!*muted && !matches_saved_or_zero(current, saved, channels)) return ZOk; // Externally changed levels win.
    if (!valid_saved(saved, channels)) return ZNoRestore;
    if (!apply_levels(device, scope, channels, saved[@"levels"])) return ZUnknown;
    NSArray *after = levels(device, scope, channels);
    if (!same_levels(after, saved[@"levels"])) return ZUnknown;
    *muted = all_zero(after);
    [store removeObjectForKey:key];
    return [store synchronize] ? ZOk : ZUnknown;
}

static int microphone(AudioObjectID device, BOOL writing, BOOL mute, BOOL *muted) {
    AudioObjectPropertyScope scope = kAudioDevicePropertyScopeInput;
    NSArray<NSNumber *> *channels = elements(device, scope, kAudioDevicePropertyMute, YES);
    BOOL native = channels != nil;
    BOOL levelMuted = NO;
    if (!native) {
        int code = volume_mute(device, writing, mute, &levelMuted);
        if (code != ZOk) return code;
        // A read-only hardware mute must not be advertised as live after restoring gain.
        channels = elements(device, scope, kAudioDevicePropertyMute, NO);
    }
    BOOL nativeMuted = channels.count > 0;
    for (NSNumber *channel in channels) {
        AudioObjectPropertyAddress prop = address(kAudioDevicePropertyMute, scope, channel.unsignedIntValue);
        UInt32 value = mute ? 1 : 0;
        if (writing && native && !write_property(device, prop, &value, sizeof(value))) return ZUnknown;
        if (!read_property(device, prop, &value, sizeof(value))) return writing ? ZUnknown : ZNoControl;
        if (!value) nativeMuted = NO;
    }
    *muted = nativeMuted || levelMuted;
    return ZOk;
}
static int output(AudioObjectID device, BOOL writing, int target, ZdeckResult *result) {
    AudioObjectPropertyScope scope = kAudioDevicePropertyScopeOutput;
    NSArray *channels = elements(device, scope, kAudioDevicePropertyVolumeScalar, writing);
    if (!channels) return ZNoControl;
    if (writing) {
        NSMutableArray *values = [NSMutableArray array];
        for (NSUInteger i = 0; i < channels.count; i++) [values addObject:@(target / 100.0)];
        if (!apply_levels(device, scope, channels, values)) return ZUnknown;
    }
    NSArray<NSNumber *> *values = levels(device, scope, channels);
    if (!values) return writing ? ZUnknown : ZNoControl;
    double maximum = 0;
    for (NSNumber *value in values) maximum = fmax(maximum, value.doubleValue);
    result->volume = maximum * 100;
    NSArray *muteChannels = elements(device, scope, kAudioDevicePropertyMute, NO);
    result->muted = muteChannels.count > 0;
    for (NSNumber *channel in muteChannels) {
        UInt32 muted = 0;
        if (!read_property(device, address(kAudioDevicePropertyMute, scope, channel.unsignedIntValue),
                           &muted, sizeof(muted))) return writing ? ZUnknown : ZNoControl;
        if (!muted) result->muted = NO;
    }
    return ZOk;
}
int32_t zdeck_media_permission_status(void) {
    return AXIsProcessTrusted() ? 1 : 0;
}

#ifndef ZDECK_OPEN_ACCESSIBILITY
#define ZDECK_OPEN_ACCESSIBILITY() [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]]
#endif

int32_t zdeck_media_permission_request(void) {
    @autoreleasepool {
        @try {
            if (AXIsProcessTrusted()) return 1;
            NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
            BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
            // macOS still requires the user to enable zDeck; the prompt alone may not navigate.
            if (!ZDECK_OPEN_ACCESSIBILITY()) return -1;
            return trusted ? 1 : 0;
        } @catch (NSException *exception) {
            return -1;
        }
    }
}

static int media_key(void) {
    if (!AXIsProcessTrusted()) return ZPermission;
    // Public NSEvent/CGEvent media-key down/up, equivalent to the keyboard's play key.
    NSEvent *down = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint
        modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
        data1:(NX_KEYTYPE_PLAY << 16) | (0xA << 8) data2:-1];
    NSEvent *up = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint
        modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
        data1:(NX_KEYTYPE_PLAY << 16) | (0xB << 8) data2:-1];
    if (!down.CGEvent || !up.CGEvent) return ZFailed;
    CGEventPost(kCGHIDEventTap, down.CGEvent);
    CGEventPost(kCGHIDEventTap, up.CGEvent);
    return ZMediaKeySent; // Event posting has no playback acknowledgement or public global snapshot.
}

ZdeckResult zdeck_system_control(int32_t operation, int32_t value) {
    @autoreleasepool {
        ZdeckResult result = {ZFailed, 0, 0};
        int lock = -1;
        @try {
            if (operation < ZReadOutput || operation > ZPlayPause ||
                (operation == ZSetOutput && (value < 0 || value > 100)) ||
                (operation == ZSetMic && value != 0 && value != 1)) {
                result.code = ZInvalid;
                return result;
            }
            if (operation == ZPlayPause) { result.code = media_key(); return result; }
            BOOL input = operation == ZReadMic || operation == ZSetMic;
            // A second app instance must not race the persistent microphone restore record.
            if (input) {
                NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                    inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"zDeck/SystemControls"];
                if (!dir || ![NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES
                    attributes:@{NSFilePosixPermissions: @0700} error:nil]) { result.code = ZPersistence; return result; }
                lock = open([[dir URLByAppendingPathComponent:@"input.lock"].path fileSystemRepresentation],
                            O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
                if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) {
                    result.code = ZPersistence;
                    return result;
                }
            }
            AudioObjectID device = kAudioObjectUnknown;
            AudioObjectPropertyAddress prop = address(input ? kAudioHardwarePropertyDefaultInputDevice :
                kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, 0);
            if (!read_property(kAudioObjectSystemObject, prop, &device, sizeof(device)) || device == kAudioObjectUnknown) {
                result.code = ZNoDevice;
            } else if (input) {
                BOOL muted = NO;
                result.code = microphone(device, operation == ZSetMic, value != 0, &muted);
                result.muted = muted;
            } else {
                result.code = output(device, operation == ZSetOutput, value, &result);
            }
        } @catch (NSException *exception) {
            // Never forward native text or assume an interrupted write was not applied.
            result.code = ZUnknown;
        } @finally {
            if (lock >= 0) { flock(lock, LOCK_UN); close(lock); }
        }
        return result;
    }
}

// Pure regression checks: no CoreAudio reads/writes, event posting or preferences changes.
int zdeck_system_macos_self_test(void) {
    @autoreleasepool {
        NSArray *channels = @[@1, @2];
        NSDictionary *saved = @{@"version": @1, @"elements": channels, @"levels": @[@0.25, @0.75]};
        return valid_saved(saved, channels) && !valid_saved(saved, @[@0]) &&
            !valid_saved(@{@"version": @1, @"elements": channels, @"levels": @[@0, @2]}, channels) &&
            !valid_saved(@{@"version": @1, @"elements": channels, @"levels": @[@0, @"bad"]}, channels) &&
            !valid_saved(@[], channels) && !valid_saved(nil, channels) &&
            all_zero(@[@0, @0]) && !all_zero(@[@0, @0.25]) && !all_zero(@[]) &&
            same_levels(@[@0.25, @0.75], saved[@"levels"]) &&
            !same_levels(@[@0, @0], saved[@"levels"]) &&
            matches_saved_or_zero(@[@0, @0.75], saved, channels) &&
            !matches_saved_or_zero(@[@0, @0.5], saved, channels) &&
            valid_saved([NSPropertyListSerialization propertyListWithData:
                [NSPropertyListSerialization dataWithPropertyList:saved format:NSPropertyListBinaryFormat_v1_0
                    options:0 error:nil] options:NSPropertyListImmutable format:NULL error:nil], channels);
    }
}
