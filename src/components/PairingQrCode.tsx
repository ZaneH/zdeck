import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** Standard QR quiet zone, in modules, kept on every side of the code. */
export const QR_QUIET_ZONE_MODULES = 4;

export interface QrMatrix {
  moduleCount: number;
  isDark: (row: number, col: number) => boolean;
}

/**
 * Encode a value into QR modules entirely on this machine. Returns null instead
 * of throwing when the value cannot be encoded, so callers can keep the
 * selectable link and copy button as the fallback.
 */
export function createQrMatrix(value: string): QrMatrix | null {
  if (!value) return null;
  try {
    // Type 0 picks the smallest version that fits; M tolerates ~15% damage.
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return {
      moduleCount: qr.getModuleCount(),
      isDark: (row, col) => qr.isDark(row, col),
    };
  } catch {
    return null;
  }
}

interface PairingQrCodeProps {
  /** Exact pairing URL, including any fragment. Encoded locally, never logged. */
  value: string;
  /** Accessible description; must not contain the pairing token. */
  label: string;
}

/**
 * Locally generated inline SVG QR code. The encoded data never leaves the
 * render: no image tag, no data URL, and no innerHTML.
 */
export function PairingQrCode({ value, label }: PairingQrCodeProps) {
  const matrix = useMemo(() => createQrMatrix(value), [value]);

  if (!matrix) {
    return (
      <p className="muted remote-qr-fallback">
        QR code unavailable. Use the pairing link above instead.
      </p>
    );
  }

  const size = matrix.moduleCount + QR_QUIET_ZONE_MODULES * 2;
  let path = "";
  for (let row = 0; row < matrix.moduleCount; row += 1) {
    for (let col = 0; col < matrix.moduleCount; col += 1) {
      if (!matrix.isDark(row, col)) continue;
      const x = col + QR_QUIET_ZONE_MODULES;
      const y = row + QR_QUIET_ZONE_MODULES;
      path += `M${x} ${y}h1v1h-1z`;
    }
  }

  return (
    <svg
      className="pairing-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
