import { gunzipSync } from 'fflate';
import { decodeNativeImage } from '../io/files';
import { assertValid, type ColorModel, type PixelDType, type TRImage } from '../model/image';
import { assertPixelLimit } from '../runtime';
import { decodeWithBrowser } from './browser';
import { decodePng } from './png';
import { salvageGzip, stripLeadingGarbage } from './recovery';

export interface CodecCapabilities {
    dtypes: PixelDType[];
    models: ColorModel[];
    multiFrame: boolean;
    lossless: boolean;
}

export interface DecodeOptions {
    path?: string;
}

export interface EncodeOptions {
    quality?: number;
    [key: string]: unknown;
}

export interface DecodedFile {
    images: TRImage[];
    labels: string[];
    info: Record<string, unknown>;
}

export interface ImageCodec {
    id: string;
    label: string;
    extensions: string[];
    mimeTypes: string[];
    capabilities: CodecCapabilities;
    sniff(head: Uint8Array): boolean;
    decode(bytes: Uint8Array, options: DecodeOptions): Promise<DecodedFile>;
    encode?(images: TRImage[], options: EncodeOptions): Promise<Uint8Array>;
}

const codecs: ImageCodec[] = [];

export function registerCodec(codec: ImageCodec): void {
    const index = codecs.findIndex((c) => c.id === codec.id);
    if (index >= 0) codecs[index] = codec;
    else codecs.push(codec);
}

export const listCodecs = (): ImageCodec[] => [...codecs];

export const getCodec = (id: string): ImageCodec | undefined => codecs.find((c) => c.id === id);

export function extensionOf(path: string): string {
    const match = /\.([a-z0-9]+)$/i.exec(path);
    return match ? match[1].toLowerCase() : '';
}

export function codecForExtension(path: string): ImageCodec | undefined {
    const ext = extensionOf(path);
    return ext ? codecs.find((c) => c.extensions.includes(ext)) : undefined;
}

export function detectCodec(bytes: Uint8Array, path?: string): ImageCodec | undefined {
    const head = bytes.subarray(0, 64);
    return codecs.find((c) => c.sniff(head)) ?? (path ? codecForExtension(path) : undefined);
}

const isGzip = (bytes: Uint8Array): boolean => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

function finalizeDecoded(decoded: DecodedFile, codecId: string, notes: string[], recoveryMethod?: string): DecodedFile {
    if (decoded.images.length === 0) throw new Error('The file contains no images.');
    for (const image of decoded.images) {
        assertPixelLimit(image.width, image.height);
        assertValid(image);
        if (notes.length > 0) {
            image.meta.history.push(...notes);
        }
    }
    const extra: Record<string, unknown> = { codec: codecId };
    if (recoveryMethod && !decoded.info.recoveryMethod) {
        extra.recovered = true;
        extra.recoveryMethod = recoveryMethod;
    }
    decoded.info = { ...extra, ...decoded.info };
    return decoded;
}

async function tryNativeRecovery(
    data: Uint8Array,
    path: string | undefined,
    formatHint: string
): Promise<DecodedFile | null> {
    const ext = (path ? extensionOf(path) : '') || (formatHint !== 'unknown' ? formatHint : '');
    const pngBytes = await decodeNativeImage(data, { path, extension: ext });
    if (!pngBytes) return null;

    let decoded: DecodedFile;
    try {
        decoded = decodePng(pngBytes);
    } catch {
        decoded = await decodeWithBrowser(pngBytes, 'image/png', formatHint);
    }
    for (const image of decoded.images) {
        image.meta.source = { ...image.meta.source, format: formatHint };
    }
    decoded.info = { ...decoded.info, format: formatHint, recovered: true, recoveryMethod: 'native' };
    return decoded;
}

export async function decodeFile(bytes: Uint8Array, options: DecodeOptions = {}): Promise<DecodedFile> {
    let data = bytes;
    let path = options.path;
    const notes: string[] = [];
    let recoveryMethod: string | undefined;

    if (isGzip(data)) {
        try {
            data = gunzipSync(data);
            if (path) path = path.replace(/\.gz$/i, '');
        } catch {
            const salvaged = salvageGzip(data);
            if (salvaged) {
                data = salvaged;
                if (path) path = path.replace(/\.gz$/i, '');
                notes.push('Recovered partial data from damaged gzip stream');
                recoveryMethod = 'gzip-salvage';
            }
        }
    }

    let codec = detectCodec(data, path);
    let stripped = false;

    if (!codec) {
        const found = stripLeadingGarbage(data);
        if (found) {
            data = found.bytes;
            codec = getCodec(found.codecId);
            stripped = true;
            notes.push(`Skipped ${found.offset} leading garbage bytes`);
            recoveryMethod = recoveryMethod ?? 'strip-leading-garbage';
        }
    }

    let primaryError: unknown;

    if (codec) {
        try {
            const decoded = await codec.decode(data, { ...options, path });
            return finalizeDecoded(decoded, codec.id, notes, recoveryMethod);
        } catch (err) {
            primaryError = err;
            console.warn(`Primary ${codec.label} decoder failed, trying recovery fallbacks:`, err);
        }
    }

    if (!stripped) {
        const found = stripLeadingGarbage(data);
        if (found) {
            const embeddedCodec = getCodec(found.codecId);
            if (embeddedCodec) {
                try {
                    const decoded = await embeddedCodec.decode(found.bytes, { ...options, path });
                    notes.push(`Skipped ${found.offset} leading garbage bytes`);
                    return finalizeDecoded(decoded, embeddedCodec.id, notes, 'strip-leading-garbage');
                } catch {
                    // Continue to native and generic browser recovery
                }
            }
        }
    }

    const formatHint = codec?.id ?? (path ? extensionOf(path) : '') ?? 'unknown';
    try {
        const nativeDecoded = await tryNativeRecovery(data, path, formatHint || 'unknown');
        if (nativeDecoded) {
            notes.push('Recovered image via native host decoder');
            return finalizeDecoded(nativeDecoded, codec?.id ?? (formatHint || 'native'), notes, 'native');
        }
    } catch {
        // Continue to generic browser fallback
    }

    try {
        const generic = await decodeWithBrowser(data, '', formatHint || 'unknown');
        notes.push('Recovered image via generic browser decoder');
        return finalizeDecoded(generic, codec?.id ?? (formatHint || 'browser'), notes, 'generic-browser');
    } catch (err) {
        if (!primaryError) primaryError = err;
    }

    if (!codec) {
        throw new Error('Unrecognized image format.');
    }
    throw primaryError instanceof Error ? primaryError : new Error(String(primaryError ?? 'Failed to decode image.'));
}
