import { ExecuteNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { readBytes } from '../../io/files';
import { parseSvgDocument, resolveDimensions } from '../../svg/svgUtils';

export class ReadSvgNode extends ExecuteNode {
    readonly typeId = 'images.read-svg';
    readonly displayName = 'Read SVG';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'Path', acceptsType: 'core:path' }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'SVG', outputType: 'core:svg' },
        { name: 'Render', outputType: 'render' },
        { name: 'Content', outputType: 'core:string' },
        { name: 'Info', outputType: 'core:dataframe' }
    ];

    readonly properties: PropertyDefinition[] = [
        {
            name: 'filePath',
            label: 'File path',
            type: 'filepath',
            defaultValue: '',
            filters: [{ name: 'SVG Images', extensions: ['svg'] }]
        }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const path = (inputs['Path'] as string) || (properties['filePath'] as string);
        if (!path) return {};

        try {
            const bytes = await readBytes(path);
            const content = new TextDecoder('utf-8').decode(bytes);
            if (!content.includes('<svg')) {
                throw new Error('File does not appear to contain valid SVG markup.');
            }

            const { svgEl } = parseSvgDocument(content);
            const { width, height, viewBox } = resolveDimensions(svgEl);
            const vbStr = viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` : '';

            const renderData = { type: 'core:svg', content };
            return {
                SVG: renderData,
                Render: renderData,
                Content: content,
                Info: recordToTable({
                    status: 'ok',
                    path,
                    bytes: bytes.length,
                    width,
                    height,
                    viewBox: vbStr
                })
            };
        } catch (err) {
            console.error('Failed to read SVG:', err);
            return { Info: errorTable(err) };
        }
    }
}
