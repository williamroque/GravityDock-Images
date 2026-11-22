import { decodeNativeImage } from '../io/files';
import { decodeWithBrowser } from './browser';
import { decodePng } from './png';
import { extensionOf, type DecodeOptions, type DecodedFile, type ImageCodec } from './registry';

const HEIC_BRANDS = new Set([
    'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'
]);

const AVIF_BRANDS = new Set(['avif', 'avis']);

function readFourCC(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function isHeicHeader(head: Uint8Array): boolean {
    if (head.length < 12) return false;
    if (readFourCC(head, 4) !== 'ftyp') return false;

    const major = readFourCC(head, 8);
    if (AVIF_BRANDS.has(major)) return false;
    if (HEIC_BRANDS.has(major)) return true;

    const boxSize = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
    const limit = Math.min(head.length, boxSize >= 16 ? boxSize : head.length);
    for (let o = 16; o + 4 <= limit; o += 4) {
        const brand = readFourCC(head, o);
        if (HEIC_BRANDS.has(brand)) return true;
    }
    return false;
}

export const heicCodec: ImageCodec = {
    id: 'heic',
    label: 'HEIC',
    extensions: ['heic', 'heif', 'hif'],
    mimeTypes: ['image/heic', 'image/heif'],
    capabilities: {
        dtypes: ['uint8', 'uint16'],
        models: ['gray', 'graya', 'rgb', 'rgba'],
        multiFrame: false,
        lossless: false
    },
    sniff: isHeicHeader,
    decode: async (bytes: Uint8Array, options: DecodeOptions): Promise<DecodedFile> => {
        const ext = extensionOf(options.path ?? '') || 'heic';
        const pngBytes = await decodeNativeImage(bytes, { path: options.path, extension: ext });
        if (pngBytes) {
            let decoded: DecodedFile;
            try {
                decoded = decodePng(pngBytes);
            } catch {
                decoded = await decodeWithBrowser(pngBytes, 'image/png', 'heic');
            }
            for (const image of decoded.images) {
                image.meta.source = { ...image.meta.source, format: 'heic' };
            }
            decoded.info = { ...decoded.info, format: 'heic', decoder: 'native' };
            return decoded;
        }

        try {
            return await decodeWithBrowser(bytes, 'image/heic', 'heic');
        } catch {
            throw new Error(
                'HEIC decoding requires the native host decoder (available on macOS via ImageIO/sips) or a HEIC-capable runtime.'
            );
        }
    }
};
