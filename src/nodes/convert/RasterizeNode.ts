import { BaseNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { createImage, describeImage, type ColorModel } from '../../model/image';
import { assertPixelLimit } from '../../runtime';
import {
    extractSvgString,
    parseBackgroundColor,
    parseLength,
    parseViewBox,
    resolveCssVarsInSvg
} from '../../svg/svgUtils';

async function rasterizeSvgToPixels(
    svgString: string,
    properties: Record<string, any>
): Promise<{ width: number; height: number; channels: 1 | 3 | 4; model: ColorModel; data: Uint8Array }> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');

    const parserError = doc.querySelector('parsererror');
    if (parserError) {
        throw new Error(`SVG parse error: ${parserError.textContent}`);
    }

    let svgEl = doc.documentElement;
    if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
        const found = doc.querySelector('svg');
        if (!found) throw new Error('No <svg> root element found in content.');
        svgEl = found;
    }

    if (!svgEl.getAttribute('xmlns')) {
        svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if (!svgEl.getAttribute('xmlns:xlink') && svgString.includes('xlink:')) {
        svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }

    resolveCssVarsInSvg(svgEl);

    const vb = parseViewBox(svgEl);
    const attrWidth = parseLength(svgEl.getAttribute('width'));
    const attrHeight = parseLength(svgEl.getAttribute('height'));

    const intrinsicWidth = attrWidth ?? vb?.width ?? 500;
    const intrinsicHeight = attrHeight ?? vb?.height ?? 500;

    if (!svgEl.hasAttribute('viewBox')) {
        svgEl.setAttribute('viewBox', `0 0 ${intrinsicWidth} ${intrinsicHeight}`);
    }

    const reqW = Math.max(0, Math.floor(Number(properties['width']) || 0));
    const reqH = Math.max(0, Math.floor(Number(properties['height']) || 0));
    const scale = Math.max(0.01, Number(properties['scale']) || 1);

    let targetWidth = 0;
    let targetHeight = 0;

    if (reqW > 0 && reqH > 0) {
        targetWidth = reqW;
        targetHeight = reqH;
    } else if (reqW > 0) {
        targetWidth = reqW;
        targetHeight = Math.max(1, Math.round(reqW * (intrinsicHeight / intrinsicWidth)));
    } else if (reqH > 0) {
        targetHeight = reqH;
        targetWidth = Math.max(1, Math.round(reqH * (intrinsicWidth / intrinsicHeight)));
    } else {
        targetWidth = Math.max(1, Math.round(intrinsicWidth * scale));
        targetHeight = Math.max(1, Math.round(intrinsicHeight * scale));
    }

    assertPixelLimit(targetWidth, targetHeight);

    svgEl.setAttribute('width', String(targetWidth));
    svgEl.setAttribute('height', String(targetHeight));

    const serializer = new XMLSerializer();
    const finalSvg = serializer.serializeToString(svgEl);

    let srcUrl = '';
    let isBlob = false;
    try {
        const blob = new Blob([finalSvg], { type: 'image/svg+xml;charset=utf-8' });
        srcUrl = URL.createObjectURL(blob);
        isBlob = true;
    } catch {
        srcUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(finalSvg)}`;
    }

    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('SVG rasterization timed out after 10 seconds.'));
            }, 10000);
            img.onload = () => {
                clearTimeout(timeout);
                resolve();
            };
            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Failed to load SVG into browser image renderer.'));
            };
            img.src = srcUrl;
        });

        let canvas: HTMLCanvasElement | OffscreenCanvas;
        let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

        if (typeof OffscreenCanvas !== 'undefined') {
            canvas = new OffscreenCanvas(targetWidth, targetHeight);
            ctx = canvas.getContext('2d', { willReadFrequently: true });
        } else {
            const c = document.createElement('canvas');
            c.width = targetWidth;
            c.height = targetHeight;
            canvas = c;
            ctx = c.getContext('2d');
        }

        if (!ctx) throw new Error('Canvas 2D context is unavailable.');

        const bg = parseBackgroundColor(properties['backgroundColor'] ?? properties['background']);
        if (bg !== 'transparent') {
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, targetWidth, targetHeight);
        }

        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        const rgba = ctx.getImageData(0, 0, targetWidth, targetHeight).data;

        let hasAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i] !== 255) {
                hasAlpha = true;
                break;
            }
        }

        const reqModel = String(properties['colorModel'] || 'auto');
        let finalModel: ColorModel;
        if (reqModel === 'rgba') finalModel = 'rgba';
        else if (reqModel === 'rgb') finalModel = 'rgb';
        else if (reqModel === 'gray') finalModel = 'gray';
        else finalModel = hasAlpha ? 'rgba' : 'rgb';

        const pixels = targetWidth * targetHeight;
        let channels: 1 | 3 | 4;
        let data: Uint8Array;

        if (finalModel === 'rgba') {
            channels = 4;
            data = new Uint8Array(pixels * 4);
            data.set(rgba);
        } else if (finalModel === 'rgb') {
            channels = 3;
            data = new Uint8Array(pixels * 3);
            for (let p = 0, s = 0, d = 0; p < pixels; p++, s += 4, d += 3) {
                data[d] = rgba[s];
                data[d + 1] = rgba[s + 1];
                data[d + 2] = rgba[s + 2];
            }
        } else {
            channels = 1;
            data = new Uint8Array(pixels);
            for (let p = 0, s = 0; p < pixels; p++, s += 4) {
                data[p] = Math.round(0.299 * rgba[s] + 0.587 * rgba[s + 1] + 0.114 * rgba[s + 2]);
            }
        }

        return { width: targetWidth, height: targetHeight, channels, model: finalModel, data };
    } finally {
        if (isBlob && srcUrl) {
            try {
                URL.revokeObjectURL(srcUrl);
            } catch {
                // ignore
            }
        }
    }
}

export class RasterizeNode extends BaseNode {
    readonly typeId = 'images.rasterize';
    readonly displayName = 'Rasterize';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        {
            name: 'SVG',
            acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'core:path', 'string']
        }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Image', outputType: 'images:image' },
        { name: 'Info', outputType: 'core:dataframe' }
    ];

    readonly properties: PropertyDefinition[] = [
        {
            name: 'scale',
            label: 'Scale factor',
            type: 'number',
            defaultValue: 1,
            min: 0.1,
            step: 0.5
        },
        {
            name: 'width',
            label: 'Width (px, 0 = auto)',
            type: 'number',
            defaultValue: 0,
            min: 0,
            step: 1
        },
        {
            name: 'height',
            label: 'Height (px, 0 = auto)',
            type: 'number',
            defaultValue: 0,
            min: 0,
            step: 1
        },
        {
            name: 'backgroundColor',
            label: 'Background color',
            type: 'string',
            defaultValue: 'transparent'
        },
        {
            name: 'colorModel',
            label: 'Color model',
            type: 'select',
            defaultValue: 'auto',
            options: [
                { label: 'Auto (RGB if opaque, RGBA if transparent)', value: 'auto' },
                { label: 'RGBA (Preserve transparency)', value: 'rgba' },
                { label: 'RGB (Solid / no alpha)', value: 'rgb' },
                { label: 'Grayscale', value: 'gray' }
            ]
        },
        {
            name: 'svg',
            label: 'SVG markup (fallback)',
            type: 'text',
            defaultValue: ''
        },
        {
            name: 'filePath',
            label: 'SVG file path (fallback)',
            type: 'filepath',
            defaultValue: '',
            filters: [{ name: 'SVG Images', extensions: ['svg'] }]
        }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const rawInput = inputs['SVG'] ?? inputs['Render'] ?? inputs['Input'] ?? (inputs && Object.values(inputs)[0]);
        let svgString = await extractSvgString(rawInput);

        if (!svgString && properties['svg']) {
            svgString = await extractSvgString(properties['svg']);
        }
        if (!svgString && properties['filePath']) {
            svgString = await extractSvgString(properties['filePath']);
        }

        if (!svgString) return {};

        try {
            const { width, height, channels, model, data } = await rasterizeSvgToPixels(svgString, properties);
            const image = createImage({
                width,
                height,
                model,
                dtype: 'uint8',
                data,
                range: [0, 255],
                meta: {
                    source: { format: 'svg' },
                    history: [`Rasterized from SVG (${width}x${height}, ${model})`]
                }
            });

            const scale = Number(properties['scale']) || 1;
            return {
                Image: image,
                Info: recordToTable({
                    status: 'ok',
                    width,
                    height,
                    channels,
                    model,
                    dtype: 'uint8',
                    scale,
                    ...describeImage(image)
                })
            };
        } catch (err) {
            console.error('Failed to rasterize SVG:', err);
            return { Info: errorTable(err) };
        }
    }
}
