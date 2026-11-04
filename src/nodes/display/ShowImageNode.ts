import { RenderNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import type { IntervalKind, StretchKind } from '../../core/scale';
import { renderImageSvg } from '../../interop/svgView';
import { isImage } from '../../model/image';

export class ShowImageNode extends RenderNode {
    readonly typeId = 'images.show';
    readonly displayName = 'Show Image';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'Image', acceptsType: ['images:image', 'images:image-array'] }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Render', outputType: 'render' }
    ];

    readonly properties: PropertyDefinition[] = [
        {
            name: 'stretch',
            label: 'Stretch',
            type: 'select',
            defaultValue: 'linear',
            options: [
                { label: 'Linear', value: 'linear' },
                { label: 'Square root', value: 'sqrt' },
                { label: 'Logarithmic', value: 'log' },
                { label: 'Inverse hyperbolic sine', value: 'asinh' },
                { label: 'Gamma', value: 'gamma' }
            ]
        },
        {
            name: 'interval',
            label: 'Interval',
            type: 'select',
            defaultValue: 'auto',
            options: [
                { label: 'Auto', value: 'auto' },
                { label: 'Min / max', value: 'minmax' },
                { label: 'Percentile', value: 'percentile' },
                { label: 'Manual', value: 'manual' }
            ]
        },
        { name: 'pLow', label: 'Percentile low', type: 'number', defaultValue: 0.5, min: 0, step: 0.1 },
        { name: 'pHigh', label: 'Percentile high', type: 'number', defaultValue: 99.5, min: 0, step: 0.1 },
        { name: 'lo', label: 'Manual low', type: 'number', defaultValue: 0 },
        { name: 'hi', label: 'Manual high', type: 'number', defaultValue: 1 },
        { name: 'gamma', label: 'Gamma', type: 'number', defaultValue: 2.2, min: 0.1, step: 0.1 },
        {
            name: 'colormap',
            label: 'Colormap (Grayscale)',
            type: 'select',
            defaultValue: 'greys',
            options: [
                { label: 'Grayscale (Default)', value: 'greys' },
                { label: 'Viridis', value: 'viridis' },
                { label: 'Plasma', value: 'plasma' },
                { label: 'Inferno', value: 'inferno' },
                { label: 'Magma', value: 'magma' },
                { label: 'Turbo', value: 'turbo' },
                { label: 'Cubehelix', value: 'cubehelix' },
                { label: 'Coolwarm', value: 'coolwarm' },
                { label: 'Heat / Thermal', value: 'heat' },
                { label: 'Jet / Rainbow', value: 'jet' },
                { label: 'Cool', value: 'cool' },
                { label: 'Bone', value: 'bone' },
                { label: 'Copper', value: 'copper' },
                { label: 'Cividis', value: 'cividis' }
            ]
        },
        {
            name: 'invertColormap',
            label: 'Invert Colormap',
            type: 'boolean',
            defaultValue: false
        },
        { name: 'maxDim', label: 'Max display size (px)', type: 'number', defaultValue: 1024, min: 64, step: 64 },
        { name: 'frame', label: 'Frame / Index', type: 'number', defaultValue: 0, min: 0, step: 1 }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        let image = inputs['Image'];
        if (Array.isArray(image)) {
            const requested = Math.floor(Number(properties['frame']) || 0);
            const index = Math.min(Math.max(requested, 0), image.length - 1);
            image = image[index];
        }
        if (!isImage(image)) return {};

        const content = renderImageSvg(image, {
            maxDim: Number(properties['maxDim']) || 1024,
            stretch: String(properties['stretch'] || 'linear') as StretchKind,
            interval: String(properties['interval'] || 'auto') as IntervalKind,
            intervalOptions: {
                lo: Number(properties['lo']),
                hi: Number(properties['hi']),
                pLow: Number(properties['pLow']),
                pHigh: Number(properties['pHigh'])
            },
            gamma: Number(properties['gamma']) || 2.2,
            colormap: String(properties['colormap'] || 'greys') as any,
            invertColormap: Boolean(properties['invertColormap'])
        });

        const renderData = { type: 'core:svg', content };
        return { Render: renderData, ...renderData };
    }
}
