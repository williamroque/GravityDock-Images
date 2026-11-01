import { BaseNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { getCodec } from '../../codecs/registry';
import { pngCodec } from '../../codecs/png';
import { prepareForEncode } from '../../core/convert';
import { toBase64 } from '../../interop/base64';
import { isImage } from '../../model/image';

export class ImageToSvgNode extends BaseNode {
    readonly typeId = 'images.image-to-svg';
    readonly displayName = 'Image to SVG';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'Image', acceptsType: 'images:image' }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'SVG', outputType: 'core:svg' },
        { name: 'Render', outputType: 'render' },
        { name: 'Content', outputType: 'core:string' }
    ];

    readonly properties: PropertyDefinition[] = [
        { name: 'width', label: 'Target width (0 = auto)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'height', label: 'Target height (0 = auto)', type: 'number', defaultValue: 0, min: 0 },
        {
            name: 'preserveAspectRatio',
            label: 'Preserve aspect ratio',
            type: 'select',
            defaultValue: 'xMidYMid meet',
            options: [
                { label: 'Fit within (xMidYMid meet)', value: 'xMidYMid meet' },
                { label: 'Cover (xMidYMid slice)', value: 'xMidYMid slice' },
                { label: 'Stretch (none)', value: 'none' }
            ]
        },
        {
            name: 'rendering',
            label: 'Pixel rendering',
            type: 'select',
            defaultValue: 'pixelated',
            options: [
                { label: 'Pixelated (sharp / pixel art)', value: 'pixelated' },
                { label: 'Crisp edges', value: 'crisp-edges' },
                { label: 'Smooth (auto)', value: 'auto' }
            ]
        },
        {
            name: 'embedFormat',
            label: 'Embed format',
            type: 'select',
            defaultValue: 'png',
            options: [
                { label: 'PNG (Lossless)', value: 'png' },
                { label: 'WebP', value: 'webp' }
            ]
        },
        { name: 'quality', label: 'Quality (WebP)', type: 'number', defaultValue: 0.92, min: 0.01, step: 0.05 }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const image = inputs['Image'];
        if (!isImage(image)) return {};

        const reqFormat = String(properties['embedFormat'] || 'png').toLowerCase();
        const codec = (reqFormat === 'webp' ? getCodec('webp') : null) || pngCodec;
        if (!codec.encode) throw new Error(`${codec.label} encoder is not available.`);

        const prepared = prepareForEncode(image, codec.capabilities, 'auto', codec.label);
        const quality = Math.max(0.01, Math.min(1, Number(properties['quality']) || 0.92));
        const bytes = await codec.encode([prepared.image], { quality });
        const base64Data = toBase64(bytes);
        const mimeType = codec.mimeTypes[0] || 'image/png';

        const reqW = Math.max(0, Math.floor(Number(properties['width']) || 0));
        const reqH = Math.max(0, Math.floor(Number(properties['height']) || 0));
        const targetW = reqW > 0 ? reqW : image.width;
        const targetH = reqH > 0 ? reqH : image.height;

        const par = String(properties['preserveAspectRatio'] || 'xMidYMid meet');
        const rendering = String(properties['rendering'] || 'pixelated');
        const href = `data:${mimeType};base64,${base64Data}`;

        const content = `<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' ` +
            `width='${targetW}' height='${targetH}' viewBox='0 0 ${image.width} ${image.height}'>` +
            `<image href='${href}' x='0' y='0' width='${image.width}' height='${image.height}' ` +
            `preserveAspectRatio='${par}' style='image-rendering:${rendering}'/>` +
            `</svg>`;

        const renderData = { type: 'core:svg', content };
        return {
            SVG: renderData,
            Render: renderData,
            Content: content
        };
    }
}
