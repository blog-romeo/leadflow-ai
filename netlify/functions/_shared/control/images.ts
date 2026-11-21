/**
 * Validazione delle immagini di branding caricate dai rivenditori.
 * • Tipo riconosciuto dal CONTENUTO (magic bytes), non dal nome o dal Content-Type dichiarato,
 *   che deve comunque coincidere.
 * • Ammessi PNG, JPEG, WebP e (solo favicon) ICO. SVG escluso: può contenere script (XSS).
 * • Limiti di peso e di dimensioni in pixel per tipo di asset.
 */
export type AssetKind = 'logo' | 'login_logo' | 'favicon'
export type ImageType = 'png' | 'jpg' | 'webp' | 'ico'

export class ImageError extends Error {
  constructor(public code: 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch' | 'bad_dimensions' | 'corrupt') {
    super(code)
  }
}

export const LIMITS: Record<AssetKind, { maxBytes: number; maxSide: number; minSide: number; types: ImageType[] }> = {
  logo: { maxBytes: 512 * 1024, maxSide: 2048, minSide: 16, types: ['png', 'jpg', 'webp'] },
  login_logo: { maxBytes: 512 * 1024, maxSide: 2048, minSide: 16, types: ['png', 'jpg', 'webp'] },
  favicon: { maxBytes: 128 * 1024, maxSide: 512, minSide: 16, types: ['png', 'ico'] },
}

export const MIME: Record<ImageType, string[]> = {
  png: ['image/png'],
  jpg: ['image/jpeg'],
  webp: ['image/webp'],
  ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
}

export function detectType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp'
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4]! | (b[5]! << 8)) > 0) return 'ico'
  return null
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8)
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)

export function dimensions(b: Uint8Array, type: ImageType): { width: number; height: number } {
  if (type === 'png') {
    if (b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') throw new ImageError('corrupt')
    return { width: u32be(b, 16), height: u32be(b, 20) }
  }
  if (type === 'jpg') {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) throw new ImageError('corrupt')
      const marker = b[o + 1]!
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2
        continue
      }
      const len = u16be(b, o + 2)
      // SOF0..SOF15 tranne DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: u16be(b, o + 5), width: u16be(b, o + 7) }
      }
      if (len < 2) throw new ImageError('corrupt')
      o += 2 + len
    }
    throw new ImageError('corrupt')
  }
  if (type === 'webp') {
    const chunk = String.fromCharCode(...b.subarray(12, 16))
    if (chunk === 'VP8X' && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
    if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    }
    throw new ImageError('corrupt')
  }
  // ICO: prima immagine della directory (0 = 256 px).
  if (b.length < 22) throw new ImageError('corrupt')
  return { width: b[6] || 256, height: b[7] || 256 }
}

export function validateImage(bytes: Uint8Array, declaredMime: string, kind: AssetKind): { type: ImageType; mime: string; width: number; height: number } {
  const limits = LIMITS[kind]
  if (!bytes.length) throw new ImageError('empty')
  if (bytes.length > limits.maxBytes) throw new ImageError('too_large')
  const type = detectType(bytes)
  if (!type || !limits.types.includes(type)) throw new ImageError('unsupported_type')
  const mime = declaredMime.trim().toLowerCase()
  if (!MIME[type].includes(mime)) throw new ImageError('type_mismatch')
  const { width, height } = dimensions(bytes, type)
  if (width < limits.minSide || height < limits.minSide || width > limits.maxSide || height > limits.maxSide) throw new ImageError('bad_dimensions')
  return { type, mime: MIME[type][0]!, width, height }
}

/** Decodifica base64 rigorosa (niente caratteri estranei), con limite prima della decodifica. */
export function decodeBase64(data: string, maxBytes: number): Uint8Array {
  const clean = data.replace(/^data:[a-z/+.-]+;base64,/i, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new ImageError('corrupt')
  if ((clean.length * 3) / 4 > maxBytes + 3) throw new ImageError('too_large')
  return new Uint8Array(Buffer.from(clean, 'base64'))
}
