#include "system.h"
#include <windows.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

extern "C" ZdeckResult zdeck_system_control(int32_t operation, int32_t value) {
    ZdeckResult result = {ZFailed, 0, 0};
    if (operation < ZReadOutput || operation > ZPlayPause ||
        (operation == ZSetOutput && (value < 0 || value > 100)) ||
        (operation == ZSetMic && value != 0 && value != 1)) {
        result.code = ZInvalid;
        return result;
    }
    if (operation == ZPlayPause) {
        INPUT keys[2] = {};
        for (auto &key : keys) {
            key.type = INPUT_KEYBOARD;
            key.ki.wVk = VK_MEDIA_PLAY_PAUSE;
        }
        keys[1].ki.dwFlags = KEYEVENTF_KEYUP;
        UINT sent = SendInput(2, keys, sizeof(INPUT));
        // Release a partially sent key; never repeat the play/pause press.
        if (sent == 1) SendInput(1, &keys[1], sizeof(INPUT));
        result.code = sent == 2 ? ZMediaKeySent : sent == 0 ? ZPermission : ZUnknown;
        return result;
    }

    HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(init) && init != RPC_E_CHANGED_MODE) return result;
    struct ComScope {
        bool initialized;
        ~ComScope() { if (initialized) CoUninitialize(); }
    } scope = {SUCCEEDED(init)};
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
        CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return result;
    ComPtr<IMMDevice> device;
    bool input = operation == ZReadMic || operation == ZSetMic;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(input ? eCapture : eRender,
        eConsole, &device))) {
        result.code = ZNoDevice;
        return result;
    }
    ComPtr<IAudioEndpointVolume> endpoint;
    if (FAILED(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL,
        nullptr, reinterpret_cast<void **>(endpoint.GetAddressOf())))) {
        result.code = ZNoControl;
        return result;
    }
    bool writing = operation == ZSetMic || operation == ZSetOutput;
    if ((operation == ZSetMic && FAILED(endpoint->SetMute(value != 0, nullptr))) ||
        (operation == ZSetOutput && FAILED(endpoint->SetMasterVolumeLevelScalar(
            static_cast<float>(value) / 100.0f, nullptr)))) {
        result.code = ZUnknown;
        return result;
    }
    BOOL muted = FALSE;
    float volume = 0;
    if (FAILED(endpoint->GetMute(&muted)) ||
        (!input && FAILED(endpoint->GetMasterVolumeLevelScalar(&volume)))) {
        result.code = writing ? ZUnknown : ZNoControl;
        return result;
    }
    result.code = ZOk;
    result.volume = volume * 100.0;
    result.muted = muted != FALSE;
    return result;
}
