#pragma once
#include <stdint.h>

// Private fixed-operation ABI; no paths, commands or error text cross it.
enum ZdeckOperation { ZReadOutput, ZSetOutput, ZReadMic, ZSetMic, ZPlayPause };
enum ZdeckCode {
    ZOk, ZNoDevice, ZNoControl, ZPermission, ZFailed, ZUnknown,
    ZNoRestore, ZPersistence, ZInvalid, ZMediaKeySent
};
typedef struct {
    int32_t code;
    double volume; // 0..100; only used for output
    int32_t muted;
} ZdeckResult;
#ifdef __cplusplus
extern "C" {
#endif
ZdeckResult zdeck_system_control(int32_t operation, int32_t value);
#ifdef __cplusplus
}
#endif
