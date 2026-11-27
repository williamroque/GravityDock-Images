import { BaseNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { resizeBilinear } from '../../core/geometry';
import { toTable } from '../../interop/dataframe';
import { createImage, isImage, type TRImage } from '../../model/image';

export class MontageNode extends BaseNode {
    readonly typeId = 'images.montage';
    readonly displayName = 'Montage';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'Images', acceptsType: 'images:image-array' }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Image', outputType: 'images:image' },
        { name: 'Info', outputType: 'core:dataframe' }
    ];

    readonly properties: PropertyDefinition[] = [
        { name: 'columns', label: 'Columns (0 for auto)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'padding', label: 'Tile padding (px)', type: 'style', styleType: 'size', category: 'style', defaultValue: 'theme:com.gravitydock.images.montagePadding', min: 0 },
        { name: 'background', label: 'Background color', type: 'style', styleType: 'color', category: 'style', defaultValue: 'theme:com.gravitydock.images.montageBackground' },
        { name: 'tileWidth', label: 'Tile width (0 for auto)', type: 'style', styleType: 'size', category: 'style', defaultValue: 'theme:com.gravitydock.images.montageTileWidth', min: 0 },
        { name: 'tileHeight', label: 'Tile height (0 for auto)', type: 'style', styleType: 'size', category: 'style', defaultValue: 'theme:com.gravitydock.images.montageTileHeight', min: 0 }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const raw = inputs['Images'];
        const imageList: TRImage[] = Array.isArray(raw)
            ? raw.filter(isImage)
            : (isImage(raw) ? [raw] : []);

        if (imageList.length === 0) {
            return {
                Image: createImage({ width: 1, height: 1, model: 'rgba', dtype: 'uint8' }),
                Info: toTable([])
            };
        }

        const count = imageList.length;
        const reqCols = Math.max(0, Math.floor(Number(properties['columns']) || 0));
        const cols = reqCols > 0 ? reqCols : Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);
        const padRaw = properties['padding'];
        const pad = Math.max(0, Math.floor(Number(padRaw) || (typeof padRaw === 'string' && padRaw.startsWith('theme:') ? 4 : 0)));

        const reqTW = Math.max(0, Math.floor(Number(properties['tileWidth']) || 0));
        const reqTH = Math.max(0, Math.floor(Number(properties['tileHeight']) || 0));
        const tileW = reqTW > 0 ? reqTW : Math.max(...imageList.map(img => img.width));
        const tileH = reqTH > 0 ? reqTH : Math.max(...imageList.map(img => img.height));

        const totalWidth = cols * tileW + (cols + 1) * pad;
        const totalHeight = rows * tileH + (rows + 1) * pad;

        let bgHex = String(properties['background'] || '#000000').trim().toLowerCase();
        if (bgHex.startsWith('custom:')) bgHex = bgHex.substring(7);
        if (bgHex.startsWith('theme:')) bgHex = '#000000';
        let bgR = 0;
        let bgG = 0;
        let bgB = 0;
        let bgA = 255;

        if (bgHex.startsWith('#')) {
            const h = bgHex.slice(1);
            if (h.length === 3) {
                bgR = parseInt(h[0] + h[0], 16) || 0;
                bgG = parseInt(h[1] + h[1], 16) || 0;
                bgB = parseInt(h[2] + h[2], 16) || 0;
            } else if (h.length === 6) {
                bgR = parseInt(h.slice(0, 2), 16) || 0;
                bgG = parseInt(h.slice(2, 4), 16) || 0;
                bgB = parseInt(h.slice(4, 6), 16) || 0;
            } else if (h.length === 8) {
                bgR = parseInt(h.slice(0, 2), 16) || 0;
                bgG = parseInt(h.slice(2, 4), 16) || 0;
                bgB = parseInt(h.slice(4, 6), 16) || 0;
                bgA = parseInt(h.slice(6, 8), 16) || 0;
            }
        }

        const outData = new Uint8Array(totalWidth * totalHeight * 4);
        for (let i = 0; i < outData.length; i += 4) {
            outData[i] = bgR;
            outData[i + 1] = bgG;
            outData[i + 2] = bgB;
            outData[i + 3] = bgA;
        }

        const progressFn = count > 4 ? (globalThis as any).gravityDock?.progress : undefined;
        for (let idx = 0; idx < count; idx++) {
            if (typeof progressFn === 'function') progressFn(idx + 1, count);
            let img = imageList[idx];
            if (img.width > tileW || img.height > tileH) {
                const scale = Math.min(tileW / img.width, tileH / img.height);
                const targetW = Math.max(1, Math.round(img.width * scale));
                const targetH = Math.max(1, Math.round(img.height * scale));
                img = resizeBilinear(img, targetW, targetH);
            }

            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const cellX = pad + col * (tileW + pad);
            const cellY = pad + row * (tileH + pad);
            const offsetX = cellX + Math.floor((tileW - img.width) / 2);
            const offsetY = cellY + Math.floor((tileH - img.height) / 2);

            const { width: iw, height: ih, channels: ic, data: idata, dtype } = img;
            const [minVal, maxVal] = img.range || (dtype === 'uint8' ? [0, 255] : dtype === 'uint16' ? [0, 65535] : [0, 1]);
            const span = maxVal > minVal ? maxVal - minVal : 1;

            for (let y = 0; y < ih; y++) {
                const destRowOffset = ((offsetY + y) * totalWidth + offsetX) * 4;
                const srcRowOffset = y * iw * ic;

                for (let x = 0; x < iw; x++) {
                    const srcIdx = srcRowOffset + x * ic;
                    const dstIdx = destRowOffset + x * 4;

                    let r = 0;
                    let g = 0;
                    let b = 0;
                    let a = 255;

                    if (ic === 1) {
                        const v = idata[srcIdx];
                        const norm = dtype === 'uint8' ? v : Math.min(255, Math.max(0, Math.round(((v - minVal) / span) * 255)));
                        r = norm;
                        g = norm;
                        b = norm;
                    } else if (ic === 2) {
                        const v = idata[srcIdx];
                        const norm = dtype === 'uint8' ? v : Math.min(255, Math.max(0, Math.round(((v - minVal) / span) * 255)));
                        r = norm;
                        g = norm;
                        b = norm;
                        a = dtype === 'uint8' ? idata[srcIdx + 1] : Math.min(255, Math.max(0, Math.round(((idata[srcIdx + 1] - minVal) / span) * 255)));
                    } else if (ic === 3) {
                        if (dtype === 'uint8') {
                            r = idata[srcIdx];
                            g = idata[srcIdx + 1];
                            b = idata[srcIdx + 2];
                        } else {
                            r = Math.min(255, Math.max(0, Math.round(((idata[srcIdx] - minVal) / span) * 255)));
                            g = Math.min(255, Math.max(0, Math.round(((idata[srcIdx + 1] - minVal) / span) * 255)));
                            b = Math.min(255, Math.max(0, Math.round(((idata[srcIdx + 2] - minVal) / span) * 255)));
                        }
                    } else if (ic === 4) {
                        if (dtype === 'uint8') {
                            r = idata[srcIdx];
                            g = idata[srcIdx + 1];
                            b = idata[srcIdx + 2];
                            a = idata[srcIdx + 3];
                        } else {
                            r = Math.min(255, Math.max(0, Math.round(((idata[srcIdx] - minVal) / span) * 255)));
                            g = Math.min(255, Math.max(0, Math.round(((idata[srcIdx + 1] - minVal) / span) * 255)));
                            b = Math.min(255, Math.max(0, Math.round(((idata[srcIdx + 2] - minVal) / span) * 255)));
                            a = Math.min(255, Math.max(0, Math.round(((idata[srcIdx + 3] - minVal) / span) * 255)));
                        }
                    }

                    outData[dstIdx] = r;
                    outData[dstIdx + 1] = g;
                    outData[dstIdx + 2] = b;
                    outData[dstIdx + 3] = a;
                }
            }
        }

        const composite = createImage({
            width: totalWidth,
            height: totalHeight,
            model: 'rgba',
            dtype: 'uint8',
            data: outData,
            meta: {
                history: [`Montage of ${count} images in ${cols}x${rows} grid`]
            }
        });

        const infoRows = imageList.map((im, i) => ({
            index: i,
            row: Math.floor(i / cols),
            column: i % cols,
            width: im.width,
            height: im.height,
            channels: im.channels,
            format: im.meta?.source?.format || 'unknown'
        }));

        return {
            Image: composite,
            Info: toTable(infoRows)
        };
    }
}
