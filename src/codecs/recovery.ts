import { Gunzip, Inflate } from 'fflate';
import { createImage, modelForChannels, type PixelBuffer, type TRImage } from '../model/image';
import { assertPixelLimit } from '../runtime';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function readU32BE(b: Uint8Array, o: number): number {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32BE(b: Uint8Array, o: number, v: number): void {
    b[o] = (v >>> 24) & 0xff;
    b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff;
    b[o + 3] = v & 0xff;
}

function readU32LE(b: Uint8Array, o: number): number {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function readI32LE(b: Uint8Array, o: number): number {
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

function writeU32LE(b: Uint8Array, o: number, v: number): void {
    b[o] = v & 0xff;
    b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff;
    b[o + 3] = (v >>> 24) & 0xff;
}

function readU16LE(b: Uint8Array, o: number): number {
    return b[o] | (b[o + 1] << 8);
}

function matchBytes(data: Uint8Array, offset: number, sig: number[]): boolean {
    if (offset < 0 || offset + sig.length > data.length) return false;
    for (let i = 0; i < sig.length; i++) {
        if (data[offset + i] !== sig[i]) return false;
    }
    return true;
}

function matchAscii(data: Uint8Array, offset: number, text: string): boolean {
    if (offset < 0 || offset + text.length > data.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (data[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

function findSequence(data: Uint8Array, sig: number[], maxScan: number): number {
    const limit = Math.min(data.length - sig.length, maxScan);
    for (let i = 0; i <= limit; i++) {
        if (data[i] === sig[0] && matchBytes(data, i, sig)) return i;
    }
    return -1;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

export function salvageGzip(bytes: Uint8Array): Uint8Array | null {
    const chunks: Uint8Array[] = [];
    const gz = new Gunzip((chunk) => {
        if (chunk.length > 0) chunks.push(chunk.slice());
    });
    const step = 16384;
    try {
        for (let i = 0; i < bytes.length; i += step) {
            const end = Math.min(i + step, bytes.length);
            gz.push(bytes.subarray(i, end), end === bytes.length);
        }
    } catch {
        // Keep whatever chunks were already emitted before corruption
    }
    const out = concatChunks(chunks);
    return out.length > 0 ? out : null;
}

export interface StrippedSignature {
    bytes: Uint8Array;
    codecId: string;
    offset: number;
}

const HEIC_FTYP_BRANDS = new Set([
    'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'
]);

export function stripLeadingGarbage(bytes: Uint8Array, maxScan = 65536): StrippedSignature | null {
    const limit = Math.min(bytes.length, maxScan);

    const candidates: Array<{ offset: number; codecId: string }> = [];

    const pngOff = findSequence(bytes, PNG_SIG, limit);
    if (pngOff > 0) candidates.push({ offset: pngOff, codecId: 'png' });

    const jpgOff = findSequence(bytes, [0xff, 0xd8, 0xff], limit);
    if (jpgOff > 0) candidates.push({ offset: jpgOff, codecId: 'jpeg' });

    for (let i = 1; i + 12 <= limit; i++) {
        if (bytes[i] === 0x52 && matchAscii(bytes, i, 'RIFF') && matchAscii(bytes, i + 8, 'WEBP')) {
            candidates.push({ offset: i, codecId: 'webp' });
            break;
        }
    }

    for (let i = 1; i + 6 <= limit; i++) {
        if (bytes[i] === 0x47 && (matchAscii(bytes, i, 'GIF89a') || matchAscii(bytes, i, 'GIF87a'))) {
            candidates.push({ offset: i, codecId: 'gif' });
            break;
        }
    }

    for (let i = 1; i + 12 <= limit; i++) {
        if (bytes[i] === 0x66 && matchAscii(bytes, i, 'ftyp') && i >= 4) {
            const boxStart = i - 4;
            const brand = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
            if (brand === 'avif' || brand === 'avis') {
                candidates.push({ offset: boxStart, codecId: 'avif' });
                break;
            }
            if (HEIC_FTYP_BRANDS.has(brand)) {
                candidates.push({ offset: boxStart, codecId: 'heic' });
                break;
            }
        }
    }

    for (let i = 1; i + 9 <= limit; i++) {
        if (bytes[i] === 0x53 && matchAscii(bytes, i, 'SIMPLE  =')) {
            candidates.push({ offset: i, codecId: 'fits' });
            break;
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.offset - b.offset);
    const best = candidates[0];
    return { bytes: bytes.subarray(best.offset), codecId: best.codecId, offset: best.offset };
}

function buildPngChunk(type: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + payload.length);
    writeU32BE(out, 0, payload.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    writeU32BE(out, 8 + payload.length, crc32(out, 4, 8 + payload.length));
    return out;
}

const PNG_KEEP_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT']);

export function repairPngStructure(bytes: Uint8Array): Uint8Array | null {
    const sigOff = findSequence(bytes, PNG_SIG, 65536);
    if (sigOff < 0 || sigOff + 8 >= bytes.length) return null;

    const outChunks: Uint8Array[] = [new Uint8Array(PNG_SIG)];
    let pos = sigOff + 8;
    let hasIhdr = false;
    let hasIdat = false;

    while (pos + 8 <= bytes.length) {
        const len = readU32BE(bytes, pos);
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        const validType = /^[A-Za-z]{4}$/.test(type);
        if (!validType) break;

        if (type === 'IEND') break;

        const dataStart = pos + 8;
        const available = bytes.length - dataStart;
        if (len > available) {
            if (type === 'IDAT' && available > 0) {
                outChunks.push(buildPngChunk('IDAT', bytes.subarray(dataStart)));
                hasIdat = true;
            }
            break;
        }

        const payload = bytes.subarray(dataStart, dataStart + len);
        if (type === 'IHDR' && len === 13) {
            hasIhdr = true;
            outChunks.push(buildPngChunk('IHDR', payload));
        } else if (PNG_KEEP_CHUNKS.has(type)) {
            if (type === 'IDAT') hasIdat = true;
            outChunks.push(buildPngChunk(type, payload));
        }

        pos = dataStart + len + 4;
    }

    if (!hasIhdr || !hasIdat) return null;
    outChunks.push(buildPngChunk('IEND', new Uint8Array(0)));
    return concatChunks(outChunks);
}

function paethPredictor(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function inflatePartialZlib(zlibBytes: Uint8Array): Uint8Array {
    if (zlibBytes.length < 3) return new Uint8Array(0);
    const cmf = zlibBytes[0];
    const flg = zlibBytes[1];
    let headerLen = 2;
    if ((cmf & 0x0f) === 8 && ((cmf * 256 + flg) % 31) === 0) {
        if (flg & 0x20) headerLen = 6;
    } else {
        headerLen = 0;
    }

    const deflateBody = zlibBytes.subarray(headerLen);
    const chunks: Uint8Array[] = [];
    const inflator = new Inflate((chunk) => {
        if (chunk.length > 0) chunks.push(chunk.slice());
    });

    const step = 4096;
    try {
        for (let i = 0; i < deflateBody.length; i += step) {
            const end = Math.min(i + step, deflateBody.length);
            inflator.push(deflateBody.subarray(i, end), false);
        }
        inflator.push(new Uint8Array(0), true);
    } catch {
        // Partial stream already collected in chunks
    }
    return concatChunks(chunks);
}

export function salvagePartialPng(bytes: Uint8Array): TRImage | null {
    const sigOff = findSequence(bytes, PNG_SIG, 65536);
    if (sigOff < 0 || sigOff + 33 > bytes.length) return null;

    let pos = sigOff + 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idatParts: Uint8Array[] = [];

    while (pos + 8 <= bytes.length) {
        const len = readU32BE(bytes, pos);
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        if (!/^[A-Za-z]{4}$/.test(type)) break;
        const dataStart = pos + 8;
        const available = bytes.length - dataStart;

        if (type === 'IHDR' && available >= 13) {
            width = readU32BE(bytes, dataStart);
            height = readU32BE(bytes, dataStart + 4);
            bitDepth = bytes[dataStart + 8];
            colorType = bytes[dataStart + 9];
            interlace = bytes[dataStart + 12];
        } else if (type === 'PLTE' && len <= available) {
            palette = bytes.subarray(dataStart, dataStart + len);
        } else if (type === 'tRNS' && len <= available) {
            trns = bytes.subarray(dataStart, dataStart + len);
        } else if (type === 'IDAT') {
            const take = Math.min(len, available);
            if (take > 0) idatParts.push(bytes.subarray(dataStart, dataStart + take));
            if (len > available) break;
        } else if (type === 'IEND') {
            break;
        }

        if (len > available) break;
        pos = dataStart + len + 4;
    }

    if (width <= 0 || height <= 0 || interlace !== 0 || idatParts.length === 0) return null;
    if (![1, 2, 4, 8, 16].includes(bitDepth)) return null;
    assertPixelLimit(width, height);

    const samplesPerPixel =
        colorType === 0 ? 1 :
        colorType === 2 ? 3 :
        colorType === 3 ? 1 :
        colorType === 4 ? 2 :
        colorType === 6 ? 4 : 0;
    if (samplesPerPixel === 0) return null;

    const raw = inflatePartialZlib(concatChunks(idatParts));
    if (raw.length < 2) return null;

    const bitsPerPixel = samplesPerPixel * bitDepth;
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const rowStep = stride + 1;

    const reconstructed = new Uint8Array(height * stride);
    const prev = new Uint8Array(stride);
    let recoveredRows = 0;

    for (let y = 0; y < height; y++) {
        const srcRow = y * rowStep;
        if (srcRow + 1 >= raw.length) break;

        const filter = raw[srcRow];
        const availableBytes = Math.min(stride, raw.length - (srcRow + 1));
        const dstRow = y * stride;

        for (let x = 0; x < availableBytes; x++) {
            const val = raw[srcRow + 1 + x];
            const a = x >= bpp ? reconstructed[dstRow + x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;

            let out: number;
            switch (filter) {
                case 0: out = val; break;
                case 1: out = (val + a) & 0xff; break;
                case 2: out = (val + b) & 0xff; break;
                case 3: out = (val + ((a + b) >>> 1)) & 0xff; break;
                case 4: out = (val + paethPredictor(a, b, c)) & 0xff; break;
                default: out = val; break;
            }
            reconstructed[dstRow + x] = out;
        }

        prev.set(reconstructed.subarray(dstRow, dstRow + stride));
        recoveredRows++;
    }

    if (recoveredRows === 0) return null;

    if (colorType === 3) {
        if (!palette || palette.length < 3) return null;
        const hasAlpha = !!trns && trns.length > 0;
        const outChannels = hasAlpha ? 4 : 3;
        const out = new Uint8Array(width * height * outChannels);
        const mask = (1 << bitDepth) - 1;
        const pixelsPerByte = 8 / bitDepth;

        for (let y = 0; y < recoveredRows; y++) {
            const rowOff = y * stride;
            for (let x = 0; x < width; x++) {
                const byteVal = reconstructed[rowOff + Math.floor(x / pixelsPerByte)];
                const shift = 8 - bitDepth * ((x % pixelsPerByte) + 1);
                const idx = (byteVal >>> shift) & mask;
                const pOff = idx * 3;
                const o = (y * width + x) * outChannels;
                out[o] = palette[pOff] ?? 0;
                out[o + 1] = palette[pOff + 1] ?? 0;
                out[o + 2] = palette[pOff + 2] ?? 0;
                if (hasAlpha) out[o + 3] = idx < trns!.length ? trns![idx] : 255;
            }
        }

        return createImage({
            width,
            height,
            model: modelForChannels(outChannels),
            dtype: 'uint8',
            data: out,
            range: [0, 255],
            meta: { source: { format: 'png' }, history: [`Recovered ${recoveredRows}/${height} scanlines from damaged PNG`] }
        });
    }

    if (bitDepth === 16) {
        const out = new Uint16Array(width * height * samplesPerPixel);
        for (let y = 0; y < recoveredRows; y++) {
            const rowOff = y * stride;
            const outRow = y * width * samplesPerPixel;
            for (let i = 0; i < width * samplesPerPixel; i++) {
                const bi = rowOff + i * 2;
                out[outRow + i] = (reconstructed[bi] << 8) | reconstructed[bi + 1];
            }
        }
        return createImage({
            width,
            height,
            model: modelForChannels(samplesPerPixel),
            dtype: 'uint16',
            data: out,
            range: [0, 65535],
            meta: { source: { format: 'png' }, history: [`Recovered ${recoveredRows}/${height} scanlines from damaged PNG`] }
        });
    }

    let out: PixelBuffer;
    if (bitDepth === 8) {
        out = reconstructed;
    } else {
        const scaled = new Uint8Array(width * height * samplesPerPixel);
        const mask = (1 << bitDepth) - 1;
        const samplesPerByte = 8 / bitDepth;
        for (let y = 0; y < recoveredRows; y++) {
            const rowOff = y * stride;
            const outRow = y * width * samplesPerPixel;
            for (let i = 0; i < width * samplesPerPixel; i++) {
                const byteVal = reconstructed[rowOff + Math.floor(i / samplesPerByte)];
                const shift = 8 - bitDepth * ((i % samplesPerByte) + 1);
                scaled[outRow + i] = Math.round((((byteVal >>> shift) & mask) * 255) / mask);
            }
        }
        out = scaled;
    }

    return createImage({
        width,
        height,
        model: modelForChannels(samplesPerPixel),
        dtype: 'uint8',
        data: out,
        range: [0, 255],
        meta: { source: { format: 'png' }, history: [`Recovered ${recoveredRows}/${height} scanlines from damaged PNG`] }
    });
}

export function repairJpeg(bytes: Uint8Array): Uint8Array | null {
    const soi = findSequence(bytes, [0xff, 0xd8], 65536);
    if (soi < 0 || soi + 4 >= bytes.length) return null;

    const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
    let pos = soi + 2;
    let foundSos = false;

    while (pos + 2 <= bytes.length) {
        while (pos < bytes.length && bytes[pos] !== 0xff) pos++;
        while (pos < bytes.length && bytes[pos] === 0xff) pos++;
        if (pos >= bytes.length) break;

        const marker = bytes[pos++];
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            continue;
        }
        if (marker === 0xd9) {
            break;
        }
        if (marker === 0xda) {
            parts.push(new Uint8Array([0xff, 0xda]));
            parts.push(bytes.subarray(pos));
            foundSos = true;
            break;
        }

        if (pos + 2 > bytes.length) break;
        const segLen = (bytes[pos] << 8) | bytes[pos + 1];
        if (segLen < 2 || pos + segLen > bytes.length) {
            break;
        }

        const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
        if (!isMetadata) {
            parts.push(new Uint8Array([0xff, marker]));
            parts.push(bytes.subarray(pos, pos + segLen));
        }

        pos += segLen;
    }

    if (!foundSos) {
        const sliced = bytes.subarray(soi);
        if (sliced.length >= 2 && sliced[sliced.length - 2] === 0xff && sliced[sliced.length - 1] === 0xd9) {
            return soi > 0 ? sliced.slice() : null;
        }
        return concatChunks([sliced, new Uint8Array([0xff, 0xd9])]);
    }

    const joined = concatChunks(parts);
    if (joined.length >= 2 && joined[joined.length - 2] === 0xff && joined[joined.length - 1] === 0xd9) {
        return joined;
    }
    return concatChunks([joined, new Uint8Array([0xff, 0xd9])]);
}

export function repairRiffWebp(bytes: Uint8Array): Uint8Array | null {
    let start = -1;
    const limit = Math.min(bytes.length - 12, 65536);
    for (let i = 0; i <= limit; i++) {
        if (bytes[i] === 0x52 && matchAscii(bytes, i, 'RIFF') && matchAscii(bytes, i + 8, 'WEBP')) {
            start = i;
            break;
        }
    }
    if (start < 0) return null;
    const copy = bytes.slice(start);
    const expectedSize = copy.length - 8;
    if (readU32LE(copy, 4) !== expectedSize || start > 0) {
        writeU32LE(copy, 4, expectedSize);
        return copy;
    }
    return null;
}

export function repairGif(bytes: Uint8Array): Uint8Array | null {
    let start = -1;
    const limit = Math.min(bytes.length - 6, 65536);
    for (let i = 0; i <= limit; i++) {
        if (bytes[i] === 0x47 && (matchAscii(bytes, i, 'GIF89a') || matchAscii(bytes, i, 'GIF87a'))) {
            start = i;
            break;
        }
    }
    if (start < 0) return null;
    const sliced = bytes.subarray(start);
    if (sliced[sliced.length - 1] === 0x3b) {
        return start > 0 ? sliced.slice() : null;
    }
    return concatChunks([sliced, new Uint8Array([0x3b])]);
}

export function repairBmp(bytes: Uint8Array): Uint8Array | null {
    if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
    const copy = bytes.slice();
    if (readU32LE(copy, 2) !== copy.length) {
        writeU32LE(copy, 2, copy.length);
        return copy;
    }
    return null;
}

export function salvagePartialBmp(bytes: Uint8Array): TRImage | null {
    if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
    const pixelOffset = readU32LE(bytes, 10);
    const dibSize = readU32LE(bytes, 14);
    if (dibSize < 40) return null;

    const width = readI32LE(bytes, 18);
    const rawHeight = readI32LE(bytes, 22);
    const planes = readU16LE(bytes, 26);
    const bpp = readU16LE(bytes, 28);
    const compression = readU32LE(bytes, 30);

    const height = Math.abs(rawHeight);
    const topDown = rawHeight < 0;
    if (width <= 0 || height <= 0 || planes !== 1 || compression !== 0) return null;
    if (bpp !== 24 && bpp !== 32) return null;
    assertPixelLimit(width, height);

    const srcBytesPerPixel = bpp / 8;
    const rowStride = Math.ceil((width * srcBytesPerPixel) / 4) * 4;
    const outChannels = bpp === 32 ? 4 : 3;
    const out = new Uint8Array(width * height * outChannels);
    let recoveredRows = 0;

    for (let row = 0; row < height; row++) {
        const srcRow = pixelOffset + row * rowStride;
        if (srcRow >= bytes.length) break;
        const dstY = topDown ? row : (height - 1 - row);
        const dstRow = dstY * width * outChannels;
        const maxCols = Math.min(width, Math.floor((bytes.length - srcRow) / srcBytesPerPixel));

        for (let x = 0; x < maxCols; x++) {
            const s = srcRow + x * srcBytesPerPixel;
            const d = dstRow + x * outChannels;
            out[d] = bytes[s + 2];
            out[d + 1] = bytes[s + 1];
            out[d + 2] = bytes[s];
            if (outChannels === 4) out[d + 3] = bytes[s + 3];
        }
        if (maxCols > 0) recoveredRows++;
    }

    if (recoveredRows === 0) return null;

    return createImage({
        width,
        height,
        model: outChannels === 4 ? 'rgba' : 'rgb',
        dtype: 'uint8',
        data: out,
        range: [0, 255],
        meta: { source: { format: 'bmp' }, history: [`Recovered ${recoveredRows}/${height} rows from damaged BMP`] }
    });
}
