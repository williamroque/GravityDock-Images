import { BaseNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import {
    extractSvgString,
    parseBackgroundColor,
    parseSvgDocument,
    resolveCssVarsInSvg,
    resolveDimensions,
    serializeSvgDocument
} from '../../svg/svgUtils';

export class TransformSvgNode extends BaseNode {
    readonly typeId = 'images.transform-svg';
    readonly displayName = 'Transform SVG';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'SVG', acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'core:path', 'string'] }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'SVG', outputType: 'core:svg' },
        { name: 'Render', outputType: 'render' },
        { name: 'Content', outputType: 'core:string' }
    ];

    readonly properties: PropertyDefinition[] = [
        { name: 'width', label: 'Width (px, 0 = auto)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'height', label: 'Height (px, 0 = auto)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'scale', label: 'Scale factor', type: 'number', defaultValue: 1, min: 0.01, step: 0.1 },
        { name: 'rotation', label: 'Rotation (degrees)', type: 'number', defaultValue: 0, step: 15 },
        { name: 'padding', label: 'Padding (px)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'viewBox', label: 'ViewBox override (x y w h)', type: 'string', defaultValue: '' },
        {
            name: 'preserveAspectRatio',
            label: 'Preserve aspect ratio',
            type: 'select',
            defaultValue: 'xMidYMid meet',
            options: [
                { label: 'Fit (xMidYMid meet)', value: 'xMidYMid meet' },
                { label: 'Cover (xMidYMid slice)', value: 'xMidYMid slice' },
                { label: 'Stretch (none)', value: 'none' }
            ]
        },
        { name: 'backgroundColor', label: 'Background color', type: 'string', defaultValue: 'transparent' },
        { name: 'resolveThemeVars', label: 'Resolve theme CSS variables', type: 'boolean', defaultValue: false }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const raw = inputs['SVG'] ?? inputs['Render'] ?? inputs['Input'] ?? (inputs && Object.values(inputs)[0]);
        const svgString = await extractSvgString(raw);
        if (!svgString) return {};

        const { doc, svgEl } = parseSvgDocument(svgString);

        if (properties['resolveThemeVars']) {
            resolveCssVarsInSvg(svgEl);
        }

        const { width: origW, height: origH, viewBox: origVb } = resolveDimensions(svgEl);
        const vb = origVb || { x: 0, y: 0, width: origW, height: origH };

        const scale = Math.max(0.001, Number(properties['scale']) || 1);
        const rotation = Number(properties['rotation']) || 0;
        const pad = Math.max(0, Number(properties['padding']) || 0);

        if (rotation !== 0 || scale !== 1) {
            const cx = vb.x + vb.width / 2;
            const cy = vb.y + vb.height / 2;
            const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute(
                'transform',
                `translate(${cx}, ${cy}) rotate(${rotation}) scale(${scale}) translate(${-cx}, ${-cy})`
            );
            while (svgEl.firstChild) {
                g.appendChild(svgEl.firstChild);
            }
            svgEl.appendChild(g);
        }

        const customVb = typeof properties['viewBox'] === 'string' ? properties['viewBox'].trim() : '';
        let finalVbStr = '';

        if (customVb) {
            finalVbStr = customVb;
            svgEl.setAttribute('viewBox', customVb);
        } else {
            const finalVbX = vb.x - pad;
            const finalVbY = vb.y - pad;
            const finalVbW = vb.width + pad * 2;
            const finalVbH = vb.height + pad * 2;
            finalVbStr = `${finalVbX} ${finalVbY} ${finalVbW} ${finalVbH}`;
            svgEl.setAttribute('viewBox', finalVbStr);
        }

        const reqW = Math.max(0, Math.floor(Number(properties['width']) || 0));
        const reqH = Math.max(0, Math.floor(Number(properties['height']) || 0));
        const vbParts = finalVbStr.split(/[\s,]+/).map(Number);
        const vbW = vbParts.length === 4 && vbParts[2] > 0 ? vbParts[2] : vb.width;
        const vbH = vbParts.length === 4 && vbParts[3] > 0 ? vbParts[3] : vb.height;

        let targetW = 0;
        let targetH = 0;

        if (reqW > 0 && reqH > 0) {
            targetW = reqW;
            targetH = reqH;
        } else if (reqW > 0) {
            targetW = reqW;
            targetH = Math.max(1, Math.round(reqW * (vbH / vbW)));
        } else if (reqH > 0) {
            targetH = reqH;
            targetW = Math.max(1, Math.round(reqH * (vbW / vbH)));
        } else {
            targetW = Math.max(1, Math.round(vbW));
            targetH = Math.max(1, Math.round(vbH));
        }

        svgEl.setAttribute('width', String(targetW));
        svgEl.setAttribute('height', String(targetH));

        const par = String(properties['preserveAspectRatio'] || 'xMidYMid meet');
        svgEl.setAttribute('preserveAspectRatio', par);

        const bg = parseBackgroundColor(properties['backgroundColor']);
        if (bg !== 'transparent') {
            const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(vbParts[0] || 0));
            rect.setAttribute('y', String(vbParts[1] || 0));
            rect.setAttribute('width', '100%');
            rect.setAttribute('height', '100%');
            rect.setAttribute('fill', bg);
            svgEl.insertBefore(rect, svgEl.firstChild);
        }

        const finalSvg = serializeSvgDocument(svgEl);
        const renderData = { type: 'core:svg', content: finalSvg };

        return {
            SVG: renderData,
            Render: renderData,
            Content: finalSvg
        };
    }
}
