import { FITS } from 'fitsjs-ng';
import { allocate, createImage, type PixelBuffer, type TRImage } from '../../model/image';
import { assertPixelLimit } from '../../runtime';
import type { DecodeOptions, DecodedFile, EncodeOptions, ImageCodec } from '../registry';
import { extractWcs, parseHeaderCards } from './header';
import { flipY, resolveBitpix } from './mapping';
import { encodeFitsImage } from './writer';

const FITS_MAGIC = 'SIMPLE  =';
const FITS_BLOCK = 2880;

function parseFitsTolerant(bytes: Uint8Array): { fits: any; padded: boolean } {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
        return { fits: FITS.fromArrayBuffer(arrayBuffer), padded: false };
    } catch (err) {
        const rem = bytes.byteLength % FITS_BLOCK;
        if (rem === 0) throw err;
        const paddedLen = bytes.byteLength + (FITS_BLOCK - rem);
        const padded = new Uint8Array(paddedLen);
        padded.set(bytes);
        return { fits: FITS.fromArrayBuffer(padded.buffer), padded: true };
    }
}

export const fitsCodec: ImageCodec = {
    id: 'fits',
    label: 'FITS',
    extensions: ['fits', 'fit', 'fts'],
    mimeTypes: ['image/fits', 'application/fits'],
    capabilities: {
        dtypes: ['uint8', 'uint16', 'int16', 'int32', 'float32', 'float64'],
        models: ['gray'],
        multiFrame: true,
        lossless: true
    },
    sniff: (head) => {
        if (head.length < 9) return false;
        for (let i = 0; i < FITS_MAGIC.length; i++) {
            if (head[i] !== FITS_MAGIC.charCodeAt(i)) return false;
        }
        return true;
    },
    decode: async (bytes: Uint8Array, options: DecodeOptions): Promise<DecodedFile> => {
        const { fits, padded } = parseFitsTolerant(bytes);

        const images: TRImage[] = [];
        const labels: string[] = [];
        let recovered = padded;
        const info: Record<string, unknown> = {
            format: 'fits',
            hduCount: fits.hdus.length
        };

        for (let hduIndex = 0; hduIndex < fits.hdus.length; hduIndex++) {
            try {
                const hdu = fits.hdus[hduIndex];
                const header = hdu.header;
                const dataUnit = hdu.data;

                if (!dataUnit) continue;

                const naxis = Number(header?.get?.('NAXIS') ?? 0);
                if (naxis < 2) continue;

                const width = Number(header?.get?.('NAXIS1') ?? 0);
                const height = Number(header?.get?.('NAXIS2') ?? 0);
                const depth = naxis >= 3 ? Math.max(1, Number(header?.get?.('NAXIS3') ?? 1)) : 1;

                if (width <= 0 || height <= 0) continue;
                assertPixelLimit(width, height);

                const cards = parseHeaderCards(header);
                const wcs = extractWcs(header);
                const extname = String(header?.get?.('EXTNAME') ?? `HDU_${hduIndex}`);
                const mapping = resolveBitpix(header);
                const expectedPixels = width * height;

                for (let frameIndex = 0; frameIndex < depth; frameIndex++) {
                    try {
                        let rawFrame: any;
                        if (typeof (dataUnit as any).getFrame === 'function') {
                            rawFrame = await (dataUnit as any).getFrame(frameIndex);
                        } else if (typeof (dataUnit as any).getFrameAsNumber === 'function') {
                            rawFrame = await (dataUnit as any).getFrameAsNumber(frameIndex);
                        }

                        if (!rawFrame || rawFrame.length === 0) continue;

                        let pixelData: PixelBuffer;
                        let frameTruncated = false;

                        if (mapping.applyLinearScaling) {
                            const scaled = new Float32Array(expectedPixels);
                            const count = Math.min(rawFrame.length, expectedPixels);
                            const bscale = mapping.bscale;
                            const bzero = mapping.bzero;
                            for (let i = 0; i < count; i++) {
                                scaled[i] = rawFrame[i] * bscale + bzero;
                            }
                            if (count < expectedPixels) {
                                frameTruncated = true;
                                recovered = true;
                                scaled.fill(mapping.nodata ?? 0, count);
                            }
                            pixelData = scaled;
                        } else if (rawFrame.length !== expectedPixels) {
                            const fixed = allocate(mapping.dtype, expectedPixels);
                            const count = Math.min(rawFrame.length, expectedPixels);
                            fixed.set(rawFrame.subarray ? rawFrame.subarray(0, count) : Array.prototype.slice.call(rawFrame, 0, count));
                            if (count < expectedPixels) {
                                frameTruncated = true;
                                recovered = true;
                                if (mapping.nodata !== undefined) fixed.fill(mapping.nodata, count);
                            }
                            pixelData = fixed;
                        } else {
                            pixelData = rawFrame;
                        }

                        const flipped = flipY(pixelData, width, height, 1);
                        const history: string[] = [];
                        if (padded) history.push('Padded truncated FITS file to 2880-byte block boundary');
                        if (frameTruncated) history.push('Padded truncated FITS frame data');

                        const image = createImage({
                            width,
                            height,
                            model: 'gray',
                            dtype: mapping.dtype,
                            data: flipped,
                            nodata: mapping.nodata,
                            meta: {
                                source: {
                                    format: 'fits',
                                    path: options.path,
                                    hdu: hduIndex,
                                    frame: frameIndex
                                },
                                fits: {
                                    cards,
                                    extname,
                                    flippedY: true,
                                    cubeIndex: depth > 1 ? frameIndex : undefined,
                                    wcs
                                },
                                history
                            }
                        });

                        images.push(image);
                        labels.push(depth > 1 ? `${extname} (Frame ${frameIndex + 1})` : extname);
                    } catch (frameErr) {
                        recovered = true;
                        console.warn(`Skipping unreadable FITS frame ${frameIndex} in HDU ${hduIndex}:`, frameErr);
                    }
                }
            } catch (hduErr) {
                recovered = true;
                console.warn(`Skipping unreadable FITS HDU ${hduIndex}:`, hduErr);
            }
        }

        if (images.length === 0) {
            throw new Error('FITS file does not contain any readable 2D image HDUs.');
        }

        if (recovered) {
            info.recovered = true;
            info.recoveryMethod = 'fits-tolerant';
        }

        return { images, labels, info };
    },
    encode: async (images: TRImage[], _options: EncodeOptions): Promise<Uint8Array> => {
        if (images.length === 0) {
            throw new Error('No images provided for FITS export.');
        }
        return encodeFitsImage(images[0]);
    }
};
