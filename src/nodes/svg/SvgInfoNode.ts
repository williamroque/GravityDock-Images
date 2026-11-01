import { BaseNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { extractSvgString, parseSvgDocument, resolveDimensions } from '../../svg/svgUtils';

export class SvgInfoNode extends BaseNode {
    readonly typeId = 'images.svg-info';
    readonly displayName = 'SVG Info';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'SVG', acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'core:path', 'string'] }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Info', outputType: 'core:dataframe' },
        { name: 'Width', outputType: 'core:number' },
        { name: 'Height', outputType: 'core:number' },
        { name: 'ViewBox', outputType: 'core:string' },
        { name: 'ElementCount', outputType: 'core:number' }
    ];

    readonly properties: PropertyDefinition[] = [
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
            const { width, height, viewBox } = resolveDimensions(svgEl);
            const vbStr = viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` : '';
            const aspectRatio = height > 0 ? width / height : 1;

            const allElements = doc.querySelectorAll('*');
            const totalElements = Math.max(0, allElements.length - 1);

            const paths = doc.querySelectorAll('path').length;
            const rects = doc.querySelectorAll('rect').length;
            const circles = doc.querySelectorAll('circle').length;
            const ellipses = doc.querySelectorAll('ellipse').length;
            const lines = doc.querySelectorAll('line').length;
            const polylines = doc.querySelectorAll('polyline').length;
            const polygons = doc.querySelectorAll('polygon').length;
            const texts = doc.querySelectorAll('text').length;
            const images = doc.querySelectorAll('image').length;
            const groups = doc.querySelectorAll('g').length;
            const defs = doc.querySelectorAll('defs').length;
            const styles = doc.querySelectorAll('style').length;

            const infoRecord: Record<string, unknown> = {
                status: 'ok',
                width,
                height,
                viewBox: vbStr,
                aspectRatio: Number(aspectRatio.toFixed(4)),
                elementCount: totalElements,
                paths,
                rects,
                circles,
                ellipses,
                lines,
                polylines,
                polygons,
                texts,
                images,
                groups,
                defs,
                styles
            };

            return {
                Info: recordToTable(infoRecord),
                Width: width,
                Height: height,
                ViewBox: vbStr,
                ElementCount: totalElements
            };
        } catch (err) {
            console.error('Failed to get SVG info:', err);
            return { Info: errorTable(err) };
        }
    }
}
