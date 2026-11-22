import { decode, encode } from 'fast-png';
import { decodeNativeImage } from '../io/files';
import { createImage, modelForChannels, type PixelBuffer, type TRImage } from '../model/image';
import { assertPixelLimit } from '../runtime';
import { decodeWithBrowser } from './browser';
import { repairPngStructure, salvagePartialPng } from './recovery';
import type { DecodeOptions, DecodedFile, EncodeOptions, ImageCodec } from './registry';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function expandPalette(png: any): { data: Uint8Array; channels: number } {
    const palette: number[][] = png.palette;
    const hasAlpha = palette.some((entry) => entry.length > 3);
    const channels = hasAlpha ? 4 : 3;
    const indices: ArrayLike<number> = png.data;
    const data = new Uint8Array(indices.length * channels);
    for (let i = 0; i < indices.length; i++) {
        const entry = palette[indices[i]] ?? [0, 0, 0];
        const o = i * channels;
        data[o] = entry[0];
        data[o + 1] = entry[1];
        data[o + 2] = entry[2];
        if (hasAlpha) data[o + 3] = entry.length > 3 ? entry[3] : 255;
    }
    return { data, channels };
}

export function decodePng(bytes: Uint8Array): DecodedFile {
    const png: any = decode(bytes);
    assertPixelLimit(png.width, png.height);

    let data: PixelBuffer = png.data;
    let channels: number = png.channels;
    const depth: number = png.depth;

    if (png.palette) {
        ({ data, channels } = expandPalette(png));
    } else if (depth < 8) {
        const max = (1 << depth) - 1;
        const scaled = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) scaled[i] = Math.round((data[i] * 255) / max);
        data = scaled;
    }

    const sixteen = !png.palette && depth === 16;
    const image = createImage({
        width: png.width,
        height: png.height,
        model: modelForChannels(channels),
        dtype: sixteen ? 'uint16' : 'uint8',
        data,
        range: sixteen ? [0, 65535] : [0, 255],
        meta: { source: { format: 'png' }, history: [] }
    });
    return { images: [image], labels: ['Image'], info: { format: 'png', bitDepth: sixteen ? 16 : 8 } };
}

export function encodeRawPng(width: number, height: number, channels: number, data: Uint8Array | Uint16Array): Uint8Array {
    return encode({
        width,
        height,
        data,
        depth: data instanceof Uint16Array ? 16 : 8,
        channels
    } as any);
}

export const pngCodec: ImageCodec = {
    id: 'png',
    label: 'PNG',
    extensions: ['png'],
    mimeTypes: ['image/png'],
    capabilities: {
        dtypes: ['uint8', 'uint16'],
        models: ['gray', 'graya', 'rgb', 'rgba'],
        multiFrame: false,
        lossless: true
    },
    sniff: (head) => PNG_MAGIC.every((b, i) => head[i] === b),
    decode: async (bytes: Uint8Array, options: DecodeOptions) => {
        let primaryErr: unknown;
        try {
            return decodePng(bytes);
        } catch (err) {
            primaryErr = err;
            console.warn('PNG decoder failed, attempting recovery:', err);
        }

        try {
            return await decodeWithBrowser(bytes, 'image/png', 'png');
        } catch {
            // Continue to structural repair
        }

        const repaired = repairPngStructure(bytes);
        if (repaired) {
            try {
                const decoded = decodePng(repaired);
                decoded.info = { ...decoded.info, recovered: true, recoveryMethod: 'png-repair' };
                for (const img of decoded.images) img.meta.history.push('Repaired PNG chunk structure/CRCs');
                return decoded;
            } catch {
                // Fall through to browser decode on repaired PNG
            }
            try {
                const decoded = await decodeWithBrowser(repaired, 'image/png', 'png');
                decoded.info = { ...decoded.info, recovered: true, recoveryMethod: 'png-repair-browser' };
                for (const img of decoded.images) img.meta.history.push('Repaired PNG chunk structure/CRCs');
                return decoded;
            } catch {
                // Continue to native and partial scanline salvage
            }
        }

        const nativePng = await decodeNativeImage(repaired ?? bytes, { path: options.path, extension: 'png' });
        if (nativePng) {
            try {
                const decoded = decodePng(nativePng);
                decoded.info = { ...decoded.info, recovered: true, recoveryMethod: 'native' };
                for (const img of decoded.images) img.meta.history.push('Recovered PNG via native host decoder');
                return decoded;
            } catch {
                // Continue to partial IDAT salvage
            }
        }

        const salvaged = salvagePartialPng(bytes);
        if (salvaged) {
            return {
                images: [salvaged],
                labels: ['Image'],
                info: {
                    format: 'png',
                    bitDepth: salvaged.dtype === 'uint16' ? 16 : 8,
                    recovered: true,
                    recoveryMethod: 'png-partial-idat'
                }
            };
        }

        throw primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr ?? 'Failed to decode PNG.'));
    },
    encode: async (images: TRImage[], _options: EncodeOptions) => {
        if (images.length !== 1) throw new Error('PNG stores a single image.');
        const image = images[0];
        return encodeRawPng(image.width, image.height, image.channels, image.data as Uint8Array | Uint16Array);
    }
};
