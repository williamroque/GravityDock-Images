import { createImage, type TRImage } from '../model/image';
import { assertPixelLimit } from '../runtime';
import { repairBmp, repairGif, repairJpeg, repairRiffWebp, salvagePartialBmp } from './recovery';
import type { CodecCapabilities, DecodeOptions, DecodedFile, EncodeOptions, ImageCodec } from './registry';

const startsWith = (head: Uint8Array, bytes: number[], offset = 0): boolean =>
    bytes.every((b, i) => head[offset + i] === b);

const ascii = (head: Uint8Array, text: string, offset: number): boolean =>
    [...text].every((ch, i) => head[offset + i] === ch.charCodeAt(0));

function drawSourceToImage(
    source: CanvasImageSource,
    width: number,
    height: number,
    format: string,
    extraInfo?: Record<string, unknown>
): DecodedFile {
    if (width <= 0 || height <= 0) {
        throw new Error('Decoded image has invalid dimensions.');
    }
    assertPixelLimit(width, height);

    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
    } else if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!ctx) throw new Error('Canvas 2D context is unavailable.');

    ctx.drawImage(source, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    let opaque = true;
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 255) {
            opaque = false;
            break;
        }
    }

    const pixels = width * height;
    const channels = opaque ? 3 : 4;
    const data = new Uint8Array(pixels * channels);
    if (opaque) {
        for (let p = 0, s = 0, d = 0; p < pixels; p++, s += 4, d += 3) {
            data[d] = rgba[s];
            data[d + 1] = rgba[s + 1];
            data[d + 2] = rgba[s + 2];
        }
    } else {
        data.set(rgba);
    }

    const image = createImage({
        width,
        height,
        model: opaque ? 'rgb' : 'rgba',
        dtype: 'uint8',
        data,
        range: [0, 255],
        meta: { source: { format }, history: [] }
    });
    return { images: [image], labels: ['Image'], info: { format, ...extraInfo } };
}

async function decodeWithImageBitmap(
    blob: Blob,
    format: string,
    options?: ImageBitmapOptions
): Promise<DecodedFile> {
    const bitmap = options
        ? await createImageBitmap(blob, options)
        : await createImageBitmap(blob);
    try {
        return drawSourceToImage(bitmap, bitmap.width, bitmap.height, format);
    } finally {
        bitmap.close();
    }
}

async function decodeWithHtmlImage(blob: Blob, format: string): Promise<DecodedFile> {
    if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('HTMLImageElement decoder is unavailable.');
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Image element failed to decode.'));
            el.src = url;
        });
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        return drawSourceToImage(img, width, height, format, { recovered: true, recoveryMethod: 'html-image' });
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function decodeWithBrowser(bytes: Uint8Array, mime: string, format: string): Promise<DecodedFile> {
    const blob = mime ? new Blob([bytes as BlobPart], { type: mime }) : new Blob([bytes as BlobPart]);
    let lastErr: unknown;

    try {
        return await decodeWithImageBitmap(blob, format, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
            imageOrientation: 'from-image'
        });
    } catch (err) {
        lastErr = err;
    }

    try {
        const decoded = await decodeWithImageBitmap(blob, format);
        decoded.info = { ...decoded.info, recovered: true, recoveryMethod: 'bitmap-relaxed' };
        return decoded;
    } catch (err) {
        lastErr = err;
    }

    try {
        return await decodeWithHtmlImage(blob, format);
    } catch (err) {
        lastErr = err;
    }

    if (mime) {
        try {
            const untyped = new Blob([bytes as BlobPart]);
            const decoded = await decodeWithHtmlImage(untyped, format);
            decoded.info = { ...decoded.info, recovered: true, recoveryMethod: 'html-image-sniff' };
            return decoded;
        } catch (err) {
            lastErr = err;
        }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'Browser image decoding failed.'));
}

async function encodeWithCanvas(image: TRImage, mime: string, quality: number | undefined): Promise<Uint8Array> {
    const { width, height, data, channels } = image;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is unavailable.');
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;
    const pixels = width * height;
    for (let p = 0, s = 0, d = 0; p < pixels; p++, s += channels, d += 4) {
        out[d] = data[s];
        out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2];
        out[d + 3] = channels === 4 ? data[s + 3] : 255;
    }
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: mime, quality });
    return new Uint8Array(await blob.arrayBuffer());
}

interface BrowserCodecSpec {
    id: string;
    label: string;
    extensions: string[];
    mime: string;
    sniff: (head: Uint8Array) => boolean;
    lossless: boolean;
    canEncode: boolean;
    multiFrame?: boolean;
    models?: CodecCapabilities['models'];
    repair?: (bytes: Uint8Array) => Uint8Array | null;
    salvage?: (bytes: Uint8Array) => TRImage | null;
}

function createBrowserCodec(spec: BrowserCodecSpec): ImageCodec {
    const codec: ImageCodec = {
        id: spec.id,
        label: spec.label,
        extensions: spec.extensions,
        mimeTypes: [spec.mime],
        capabilities: {
            dtypes: ['uint8'],
            models: spec.models ?? ['rgb', 'rgba'],
            multiFrame: !!spec.multiFrame,
            lossless: spec.lossless
        },
        sniff: spec.sniff,
        decode: async (bytes: Uint8Array, _options: DecodeOptions) => {
            try {
                return await decodeWithBrowser(bytes, spec.mime, spec.id);
            } catch (primaryErr) {
                if (spec.repair) {
                    const repaired = spec.repair(bytes);
                    if (repaired) {
                        try {
                            const decoded = await decodeWithBrowser(repaired, spec.mime, spec.id);
                            decoded.info = { ...decoded.info, recovered: true, recoveryMethod: `${spec.id}-repair` };
                            for (const img of decoded.images) {
                                img.meta.history.push(`Recovered damaged ${spec.label} stream`);
                            }
                            return decoded;
                        } catch {
                            // Continue to salvage fallback
                        }
                    }
                }
                if (spec.salvage) {
                    const salvaged = spec.salvage(bytes);
                    if (salvaged) {
                        return {
                            images: [salvaged],
                            labels: ['Image'],
                            info: { format: spec.id, recovered: true, recoveryMethod: `${spec.id}-salvage` }
                        };
                    }
                }
                throw primaryErr;
            }
        }
    };
    if (spec.canEncode) {
        codec.encode = async (images: TRImage[], options: EncodeOptions) => {
            if (images.length !== 1) throw new Error(`${spec.label} stores a single image.`);
            const quality = typeof options.quality === 'number' ? Math.min(1, Math.max(0.01, options.quality)) : undefined;
            return encodeWithCanvas(images[0], spec.mime, quality);
        };
    }
    return codec;
}

export const browserCodecs: ImageCodec[] = [
    createBrowserCodec({
        id: 'jpeg',
        label: 'JPEG',
        extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
        mime: 'image/jpeg',
        sniff: (h) => startsWith(h, [0xff, 0xd8, 0xff]),
        lossless: false,
        canEncode: true,
        models: ['rgb'],
        repair: repairJpeg
    }),
    createBrowserCodec({
        id: 'webp',
        label: 'WebP',
        extensions: ['webp'],
        mime: 'image/webp',
        sniff: (h) => ascii(h, 'RIFF', 0) && ascii(h, 'WEBP', 8),
        lossless: false,
        canEncode: true,
        repair: repairRiffWebp
    }),
    createBrowserCodec({
        id: 'gif',
        label: 'GIF',
        extensions: ['gif'],
        mime: 'image/gif',
        sniff: (h) => ascii(h, 'GIF8', 0),
        lossless: true,
        canEncode: false,
        repair: repairGif
    }),
    createBrowserCodec({
        id: 'bmp',
        label: 'BMP',
        extensions: ['bmp'],
        mime: 'image/bmp',
        sniff: (h) => ascii(h, 'BM', 0),
        lossless: true,
        canEncode: false,
        repair: repairBmp,
        salvage: salvagePartialBmp
    }),
    createBrowserCodec({
        id: 'avif',
        label: 'AVIF',
        extensions: ['avif'],
        mime: 'image/avif',
        sniff: (h) => ascii(h, 'ftypavif', 4) || ascii(h, 'ftypavis', 4),
        lossless: false,
        canEncode: false
    })
];

export { decodeWithBrowser };
