// Compile the real helper with fake CoreAudio entry points. No live device or
// media event API is called. Restore preferences use a separate test-only suite.
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <unistd.h>

static Boolean fake_has(AudioObjectID, const AudioObjectPropertyAddress *);
static OSStatus fake_settable(AudioObjectID, const AudioObjectPropertyAddress *, Boolean *);
static OSStatus fake_size(AudioObjectID, const AudioObjectPropertyAddress *, UInt32, const void *, UInt32 *);
static OSStatus fake_get(AudioObjectID, const AudioObjectPropertyAddress *, UInt32, const void *, UInt32 *, void *);
static OSStatus fake_set(AudioObjectID, const AudioObjectPropertyAddress *, UInt32, const void *, UInt32, const void *);
static Boolean fake_trusted(void);
static Boolean fake_trusted_options(CFDictionaryRef);
static BOOL fake_open_accessibility(void);
#define AXIsProcessTrustedWithOptions fake_trusted_options
#define ZDECK_OPEN_ACCESSIBILITY() fake_open_accessibility()
static void fake_post(CGEventTapLocation, CGEventRef);
#define AXIsProcessTrusted fake_trusted
#define CGEventPost fake_post
#define AudioObjectHasProperty fake_has
#define AudioObjectIsPropertySettable fake_settable
#define AudioObjectGetPropertyDataSize fake_size
#define AudioObjectGetPropertyData fake_get
#define AudioObjectSetPropertyData fake_set
static NSString *test_suite;
#define ZDECK_PREFS_SUITE test_suite
#include "../native/system_macos.m"

static Float32 fake_levels[2] = {0.25, 0.75};
static UInt32 fake_mutes[2] = {0, 0};
static BOOL native_mute = NO, readonly_mute = NO, no_controls = NO, ignore_writes = NO;
static int writes = 0, fail_write = -1;
static NSString *fake_uid = @"fake-device-uid";
static BOOL trusted = NO;
static int posted = 0, prompts = 0, settings_opened = 0;
static BOOL settings_available = YES;
static Boolean fake_trusted(void) { return trusted; }
static Boolean fake_trusted_options(CFDictionaryRef options) {
    assert(CFDictionaryGetValue(options, kAXTrustedCheckOptionPrompt) == kCFBooleanTrue);
    prompts++;
    return trusted;
}
static BOOL fake_open_accessibility(void) {
    settings_opened++;
    return settings_available;
}
static void fake_post(CGEventTapLocation tap, CGEventRef event) {
    assert(tap == kCGHIDEventTap);
    NSEvent *key = [NSEvent eventWithCGEvent:event];
    assert(key.type == NSEventTypeSystemDefined && key.subtype == NX_SUBTYPE_AUX_CONTROL_BUTTONS);
    assert(key.data1 == ((NX_KEYTYPE_PLAY << 16) | ((posted == 0 ? 0xA : 0xB) << 8)));
    posted++;
}

static Boolean fake_has(AudioObjectID device, const AudioObjectPropertyAddress *prop) {
    (void)device;
    if (no_controls || prop->mElement == 0 || prop->mElement > 2) return false;
    return prop->mSelector == kAudioDevicePropertyVolumeScalar ||
        (native_mute && prop->mSelector == kAudioDevicePropertyMute);
}
static OSStatus fake_settable(AudioObjectID device, const AudioObjectPropertyAddress *prop, Boolean *settable) {
    *settable = fake_has(device, prop) && !(readonly_mute && prop->mSelector == kAudioDevicePropertyMute);
    return noErr;
}
static OSStatus fake_size(AudioObjectID device, const AudioObjectPropertyAddress *prop,
                          UInt32 qualifierSize, const void *qualifier, UInt32 *size) {
    (void)device; (void)prop; (void)qualifierSize; (void)qualifier;
    *size = sizeof(AudioBufferList);
    return noErr;
}
static OSStatus fake_get(AudioObjectID device, const AudioObjectPropertyAddress *prop,
                         UInt32 qualifierSize, const void *qualifier, UInt32 *size, void *out) {
    (void)device; (void)qualifierSize; (void)qualifier;
    if (prop->mSelector == kAudioDevicePropertyStreamConfiguration) {
        AudioBufferList *list = out;
        list->mNumberBuffers = 1;
        list->mBuffers[0].mNumberChannels = 2;
        *size = sizeof(AudioBufferList);
    } else if (prop->mSelector == kAudioDevicePropertyDeviceUID) {
        *(CFStringRef *)out = CFBridgingRetain(fake_uid);
        *size = sizeof(CFStringRef);
    } else if (prop->mElement >= 1 && prop->mElement <= 2) {
        if (prop->mSelector == kAudioDevicePropertyVolumeScalar) {
            *(Float32 *)out = fake_levels[prop->mElement - 1];
            *size = sizeof(Float32);
        } else if (prop->mSelector == kAudioDevicePropertyMute && native_mute) {
            *(UInt32 *)out = fake_mutes[prop->mElement - 1];
            *size = sizeof(UInt32);
        } else return kAudioHardwareUnknownPropertyError;
    } else return kAudioHardwareUnknownPropertyError;
    return noErr;
}
static OSStatus fake_set(AudioObjectID device, const AudioObjectPropertyAddress *prop,
                         UInt32 qualifierSize, const void *qualifier, UInt32 size, const void *value) {
    (void)device; (void)qualifierSize; (void)qualifier; (void)size;
    writes++;
    if (writes == fail_write) return kAudioHardwareUnspecifiedError;
    if (ignore_writes) return noErr;
    assert(prop->mElement >= 1 && prop->mElement <= 2);
    if (prop->mSelector == kAudioDevicePropertyVolumeScalar) fake_levels[prop->mElement - 1] = *(Float32 *)value;
    else if (prop->mSelector == kAudioDevicePropertyMute) fake_mutes[prop->mElement - 1] = *(UInt32 *)value;
    else assert(false);
    return noErr;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        test_suite = argc == 2 ? [NSString stringWithUTF8String:argv[1]] :
            [NSString stringWithFormat:@"app.zdeck.system-controls.test.%d", getpid()];
        if (argc == 2) {
            // A fresh process must be able to recover from disk, not just defaults' memory cache.
            fake_levels[0] = fake_levels[1] = 0;
            BOOL muted = YES;
            assert(microphone(42, YES, NO, &muted) == ZOk && !muted);
            assert(fake_levels[0] == 0.25 && fake_levels[1] == 0.75);
            return 0;
        }
        NSUserDefaults *store = [[NSUserDefaults alloc] initWithSuiteName:ZDECK_PREFS_SUITE];
        @try {
            assert(zdeck_system_macos_self_test());
            assert(zdeck_media_permission_status() == 0);
            assert(prompts == 0 && settings_opened == 0 && posted == 0);
            assert(zdeck_media_permission_request() == 0);
            assert(prompts == 1 && settings_opened == 1 && posted == 0);
            settings_available = NO;
            assert(zdeck_media_permission_request() == -1);
            trusted = YES;
            assert(zdeck_media_permission_status() == 1);
            assert(zdeck_media_permission_request() == 1);
            assert(prompts == 2 && settings_opened == 2 && posted == 0);
            trusted = NO;
            settings_available = YES;
            BOOL muted = NO;
            // Native mute never changes gain or creates a fallback restore record.
            native_mute = YES;
            assert(microphone(42, YES, YES, &muted) == ZOk && muted);
            assert(fake_levels[0] == 0.25 && fake_levels[1] == 0.75);
            assert([store objectForKey:fake_uid] == nil);
            assert(microphone(42, YES, NO, &muted) == ZOk && !muted);
            readonly_mute = YES;
            fake_mutes[0] = fake_mutes[1] = 1;
            assert(microphone(42, NO, NO, &muted) == ZOk && muted);
            assert(microphone(42, YES, NO, &muted) == ZOk && muted); // Cannot clear a hardware switch through gain.
            readonly_mute = NO;
            native_mute = NO;

            // Fallback: exact unequal levels survive repeated mute and a new store instance.
            assert(microphone(42, YES, YES, &muted) == ZOk && muted);
            assert(microphone(42, YES, YES, &muted) == ZOk && muted);
            NSUserDefaults *reopened = [[NSUserDefaults alloc] initWithSuiteName:ZDECK_PREFS_SUITE];
            assert([reopened synchronize]);
            NSDictionary *saved = [reopened objectForKey:fake_uid];
            assert(([saved[@"levels"] isEqual:@[@0.25, @0.75]]));
            fake_uid = @"other-device";
            assert(microphone(42, YES, NO, &muted) == ZNoRestore); // Never use another device's record.
            fake_uid = @"fake-device-uid";
            NSTask *restart = [NSTask new];
            restart.executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[0]]];
            restart.arguments = @[test_suite];
            assert([restart launchAndReturnError:nil]);
            [restart waitUntilExit];
            assert(restart.terminationStatus == 0);
            // The child's fake-device write is isolated; reflect its restored levels here.
            fake_levels[0] = 0.25; fake_levels[1] = 0.75;
            assert([store synchronize] && [store objectForKey:fake_uid] == nil);

            // Failure halfway through mute retains the ORIGINAL levels for explicit restore.
            fail_write = writes + 2;
            assert(microphone(42, YES, YES, &muted) == ZUnknown);
            assert(fake_levels[0] == 0 && fake_levels[1] == 0.75);
            fail_write = -1;
            assert(microphone(42, YES, YES, &muted) == ZOk && muted); // Retry mute must not save partial zeros.
            assert(microphone(42, YES, NO, &muted) == ZOk && !muted);
            assert(fake_levels[0] == 0.25 && fake_levels[1] == 0.75);

            // Nonzero levels changed outside zDeck are never overwritten on unmute.
            assert(microphone(42, YES, YES, &muted) == ZOk && muted);
            fake_levels[0] = 0.5; fake_levels[1] = 0.625;
            int external_writes = writes;
            assert(microphone(42, YES, NO, &muted) == ZOk && !muted && writes == external_writes);
            assert(fake_levels[0] == 0.5 && fake_levels[1] == 0.625);

            // Readback mismatch is not advertised as a successful mute.
            ignore_writes = YES;
            assert(microphone(42, YES, YES, &muted) == ZOk && !muted);
            ignore_writes = NO;

            // Missing/corrupt/mismatched records never guess an unmute volume.
            fake_levels[0] = fake_levels[1] = 0;
            for (id invalid in @[@{}, @{@"version": @1, @"elements": @[@0], @"levels": @[@1]}]) {
                [store setObject:invalid forKey:fake_uid];
                assert([store synchronize]);
                int before = writes;
                assert(microphone(42, YES, NO, &muted) == ZNoRestore && writes == before);
            }
            [store removeObjectForKey:fake_uid];
            assert([store synchronize]);
            assert(microphone(42, YES, NO, &muted) == ZNoRestore);

            // No writable controls fails without an audio write.
            int before = writes;
            no_controls = YES;
            assert(microphone(42, YES, YES, &muted) == ZNoControl && writes == before);
            no_controls = NO;

            // Output scalar readback uses the actual per-channel maximum and mute state.
            ZdeckResult result = {ZFailed, 0, 0};
            assert(output(42, YES, 40, &result) == ZOk);
            assert(fabs(result.volume - 40) < 0.001 && !result.muted);
            ignore_writes = YES;
            assert(output(42, YES, 80, &result) == ZOk && fabs(result.volume - 40) < 0.001);

            // Build real NSEvents but intercept posting: permission failure sends nothing;
            // an allowed request sends exactly one down/up pair and still reports unknown.
            assert(media_key() == ZPermission && posted == 0);
            trusted = YES;
            assert(media_key() == ZMediaKeySent && posted == 2);
            assert(prompts == 2 && settings_opened == 2); // Media actions never run setup.
        } @finally {
            [store removePersistentDomainForName:ZDECK_PREFS_SUITE];
            assert([store synchronize]);
        }
        puts("macOS fake controls: mute/restore, output readback, observational trust, explicit setup, and prompt-free media passed");
    }
    return 0;
}
