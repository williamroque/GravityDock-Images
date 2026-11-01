import { RenderNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import {
    extractSvgString,
    parseBackgroundColor,
    parseSvgDocument,
    resolveCssVarsInSvg,
    serializeSvgDocument
} from '../../svg/svgUtils';

export class RenderSvgNode extends RenderNode {
    readonly typeId = 'images.render-svg';
    readonly displayName = 'Render SVG';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'SVG', acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'core:path', 'string'] }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Render', outputType: 'render' }
    ];

    readonly properties: PropertyDefinition[] = [
        { name: 'backgroundColor', label: 'Background color', type: 'string', defaultValue: 'transparent' },
        {
            name: 'fit',
            label: 'Fit mode',
            type: 'select',
            defaultValue: 'contain',
            options: [
                { label: 'Contain (Fit within)', value: 'contain' },
                { label: 'Cover (Fill area)', value: 'cover' },
                { label: 'Stretch (Ignore ratio)', value: 'fill' },
                { label: 'Original', value: 'none' }
            ]
        },
        { name: 'resolveThemeVars', label: 'Resolve theme CSS variables', type: 'boolean', defaultValue: true },
        { name: 'svg', label: 'SVG markup (fallback)', type: 'text', defaultValue: '' },
        {
            name: 'filePath',
            label: 'SVG file path (fallback)',
            type: 'filepath',
            defaultValue: '',
            filters: [{ name: 'SVG Images', extensions: ['svg'] }]
        }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const raw = inputs['SVG'] ?? inputs['Render'] ?? inputs['Input'] ?? (inputs && Object.values(inputs)[0]);
        let svgString = await extractSvgString(raw);

        if (!svgString && properties['svg']) {
            svgString = await extractSvgString(properties['svg']);
        }
        if (!svgString && properties['filePath']) {
            svgString = await extractSvgString(properties['filePath']);
        }

        if (!svgString) return {};

        try {
            const { doc, svgEl } = parseSvgDocument(svgString);

            if (properties['resolveThemeVars']) {
                resolveCssVarsInSvg(svgEl);
            }

            const fit = String(properties['fit'] || 'contain');
            if (fit === 'contain') {
                svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            } else if (fit === 'cover') {
                svgEl.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            } else if (fit === 'fill') {
                svgEl.setAttribute('preserveAspectRatio', 'none');
            }

            const bg = parseBackgroundColor(properties['backgroundColor']);
            if (bg !== 'transparent') {
                const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('width', '100%');
                rect.setAttribute('height', '100%');
                rect.setAttribute('fill', bg);
                svgEl.insertBefore(rect, svgEl.firstChild);
            }

            const finalSvg = serializeSvgDocument(svgEl);
            const renderData = { type: 'core:svg', content: finalSvg };

            return {
                Render: renderData,
                ...renderData
            };
        } catch (err) {
            console.error('Failed to render SVG:', err);
            return {};
        }
    }
}
