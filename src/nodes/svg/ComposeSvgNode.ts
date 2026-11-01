import { BaseNode } from '@gravitydock/types';
import type { DynamicInputDefinition, InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { renderImageSvg } from '../../interop/svgView';
import { isImage } from '../../model/image';
import { extractSvgString, parseBackgroundColor, parseSvgDocument, resolveDimensions } from '../../svg/svgUtils';

interface SvgItem {
    width: number;
    height: number;
    viewBox: { x: number; y: number; width: number; height: number } | null;
    innerHtml: string;
}

export class ComposeSvgNode extends BaseNode {
    readonly typeId = 'images.compose-svg';
    readonly displayName = 'Compose SVG';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'SVG', acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'images:image'] }
    ];

    readonly dynamicInputs: DynamicInputDefinition = {
        baseName: 'SVG',
        acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'images:image'],
        preserveStaticInputs: true
    };

    readonly outputs: OutputDefinition[] = [
        { name: 'SVG', outputType: 'core:svg' },
        { name: 'Render', outputType: 'render' },
        { name: 'Content', outputType: 'core:string' },
        { name: 'Count', outputType: 'core:number' }
    ];

    readonly properties: PropertyDefinition[] = [
        {
            name: 'mode',
            label: 'Layout mode',
            type: 'select',
            defaultValue: 'overlay',
            options: [
                { label: 'Overlay (Stack)', value: 'overlay' },
                { label: 'Horizontal (Row)', value: 'horizontal' },
                { label: 'Vertical (Column)', value: 'vertical' },
                { label: 'Grid', value: 'grid' }
            ]
        },
        { name: 'columns', label: 'Grid columns (0 = auto)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'gap', label: 'Gap between items (px)', type: 'number', defaultValue: 10, min: 0 },
        {
            name: 'alignment',
            label: 'Alignment',
            type: 'select',
            defaultValue: 'center',
            options: [
                { label: 'Start / Top', value: 'start' },
                { label: 'Center', value: 'center' },
                { label: 'End / Bottom', value: 'end' }
            ]
        },
        { name: 'padding', label: 'Padding (px)', type: 'number', defaultValue: 0, min: 0 },
        { name: 'backgroundColor', label: 'Background color', type: 'string', defaultValue: 'transparent' }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const rawInputs: any[] = [];
        if (inputs['SVG']) {
            if (Array.isArray(inputs['SVG'])) rawInputs.push(...inputs['SVG']);
            else rawInputs.push(inputs['SVG']);
        }

        for (let i = 1; i <= 100; i++) {
            const key = `SVG ${i}`;
            if (inputs[key]) {
                if (Array.isArray(inputs[key])) rawInputs.push(...inputs[key]);
                else rawInputs.push(inputs[key]);
            }
        }

        const items: SvgItem[] = [];
        for (const raw of rawInputs) {
            let svgStr: string | null = null;
            if (isImage(raw)) {
                svgStr = renderImageSvg(raw, {
                    maxDim: Math.max(raw.width, raw.height),
                    stretch: 'linear',
                    interval: 'auto',
                    intervalOptions: {}
                });
            } else {
                svgStr = await extractSvgString(raw);
            }

            if (!svgStr) continue;

            try {
                const { svgEl } = parseSvgDocument(svgStr);
                const { width, height, viewBox } = resolveDimensions(svgEl);
                items.push({
                    width,
                    height,
                    viewBox,
                    innerHtml: svgEl.innerHTML
                });
            } catch {
                // Ignore unparseable item
            }
        }

        if (items.length === 0) return {};

        const mode = String(properties['mode'] || 'overlay');
        const pad = Math.max(0, Number(properties['padding']) || 0);
        const gap = Math.max(0, Number(properties['gap']) || 0);
        const align = String(properties['alignment'] || 'center');

        let canvasW = 0;
        let canvasH = 0;
        const placed: { x: number; y: number; item: SvgItem }[] = [];

        if (mode === 'overlay') {
            const maxW = Math.max(...items.map((it) => it.width));
            const maxH = Math.max(...items.map((it) => it.height));
            canvasW = maxW + pad * 2;
            canvasH = maxH + pad * 2;

            for (const item of items) {
                let x = pad;
                let y = pad;
                if (align === 'center') {
                    x = pad + (maxW - item.width) / 2;
                    y = pad + (maxH - item.height) / 2;
                } else if (align === 'end') {
                    x = pad + (maxW - item.width);
                    y = pad + (maxH - item.height);
                }
                placed.push({ x, y, item });
            }
        } else if (mode === 'horizontal') {
            const totalWidths = items.reduce((sum, it) => sum + it.width, 0);
            const maxH = Math.max(...items.map((it) => it.height));
            canvasW = totalWidths + gap * (items.length - 1) + pad * 2;
            canvasH = maxH + pad * 2;

            let currentX = pad;
            for (const item of items) {
                let y = pad;
                if (align === 'center') {
                    y = pad + (maxH - item.height) / 2;
                } else if (align === 'end') {
                    y = pad + (maxH - item.height);
                }
                placed.push({ x: currentX, y, item });
                currentX += item.width + gap;
            }
        } else if (mode === 'vertical') {
            const maxW = Math.max(...items.map((it) => it.width));
            const totalHeights = items.reduce((sum, it) => sum + it.height, 0);
            canvasW = maxW + pad * 2;
            canvasH = totalHeights + gap * (items.length - 1) + pad * 2;

            let currentY = pad;
            for (const item of items) {
                let x = pad;
                if (align === 'center') {
                    x = pad + (maxW - item.width) / 2;
                } else if (align === 'end') {
                    x = pad + (maxW - item.width);
                }
                placed.push({ x, y: currentY, item });
                currentY += item.height + gap;
            }
        } else {
            // Grid mode
            const reqCols = Math.max(0, Math.floor(Number(properties['columns']) || 0));
            const cols = reqCols > 0 ? reqCols : Math.ceil(Math.sqrt(items.length));
            const rows = Math.ceil(items.length / cols);

            const colWidths = new Array(cols).fill(0);
            const rowHeights = new Array(rows).fill(0);

            for (let i = 0; i < items.length; i++) {
                const c = i % cols;
                const r = Math.floor(i / cols);
                colWidths[c] = Math.max(colWidths[c], items[i].width);
                rowHeights[r] = Math.max(rowHeights[r], items[i].height);
            }

            const totalGridW = colWidths.reduce((a, b) => a + b, 0) + gap * (cols - 1);
            const totalGridH = rowHeights.reduce((a, b) => a + b, 0) + gap * (rows - 1);
            canvasW = totalGridW + pad * 2;
            canvasH = totalGridH + pad * 2;

            const colX = [pad];
            for (let c = 0; c < cols - 1; c++) colX.push(colX[c] + colWidths[c] + gap);

            const rowY = [pad];
            for (let r = 0; r < rows - 1; r++) rowY.push(rowY[r] + rowHeights[r] + gap);

            for (let i = 0; i < items.length; i++) {
                const c = i % cols;
                const r = Math.floor(i / cols);
                const item = items[i];
                let x = colX[c];
                let y = rowY[r];
                if (align === 'center') {
                    x += (colWidths[c] - item.width) / 2;
                    y += (rowHeights[r] - item.height) / 2;
                } else if (align === 'end') {
                    x += colWidths[c] - item.width;
                    y += rowHeights[r] - item.height;
                }
                placed.push({ x, y, item });
            }
        }

        const bg = parseBackgroundColor(properties['backgroundColor']);
        let bgElement = '';
        if (bg !== 'transparent') {
            bgElement = `<rect width='${canvasW}' height='${canvasH}' fill='${bg}'/>`;
        }

        const nestedSvgs = placed.map(({ x, y, item }) => {
            const vb = item.viewBox
                ? `${item.viewBox.x} ${item.viewBox.y} ${item.viewBox.width} ${item.viewBox.height}`
                : `0 0 ${item.width} ${item.height}`;
            return `<svg x='${x}' y='${y}' width='${item.width}' height='${item.height}' viewBox='${vb}'>${item.innerHtml}</svg>`;
        }).join('\n');

        const finalSvg = `<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' ` +
            `width='${canvasW}' height='${canvasH}' viewBox='0 0 ${canvasW} ${canvasH}'>\n` +
            `${bgElement}\n` +
            `${nestedSvgs}\n` +
            `</svg>`;

        const renderData = { type: 'core:svg', content: finalSvg };
        return {
            SVG: renderData,
            Render: renderData,
            Content: finalSvg,
            Count: items.length
        };
    }
}
