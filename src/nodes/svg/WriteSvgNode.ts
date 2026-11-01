import { ExecuteNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { writeBytes } from '../../io/files';
import { extractSvgString, formatSvg } from '../../svg/svgUtils';

export class WriteSvgNode extends ExecuteNode {
    readonly typeId = 'images.write-svg';
    readonly displayName = 'Write SVG';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'SVG', acceptsType: ['core:svg', 'svg', 'render', 'core:render', 'core:string', 'string'] },
        { name: 'Path', acceptsType: 'core:path' }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Success', outputType: 'core:boolean' },
        { name: 'Info', outputType: 'core:dataframe' }
    ];

    readonly properties: PropertyDefinition[] = [
        {
            name: 'filePath',
            label: 'Output file path',
            type: 'filepath',
            defaultValue: '',
            filters: [{ name: 'SVG Images', extensions: ['svg'] }]
        },
        {
            name: 'format',
            label: 'Formatting',
            type: 'select',
            defaultValue: 'raw',
            options: [
                { label: 'As Is (Raw)', value: 'raw' },
                { label: 'Pretty Print', value: 'pretty' },
                { label: 'Minified', value: 'minified' }
            ]
        },
        {
            name: 'xmlDeclaration',
            label: 'Include XML declaration',
            type: 'boolean',
            defaultValue: false
        }
    ];

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const rawSvg = inputs['SVG'];
        const path = (inputs['Path'] as string) || (properties['filePath'] as string);
        if (!rawSvg || !path) return {};

        try {
            const svgString = await extractSvgString(rawSvg);
            if (!svgString) {
                throw new Error('No valid SVG markup found in input.');
            }

            const formatMode = (properties['format'] as 'raw' | 'pretty' | 'minified') || 'raw';
            let formatted = formatSvg(svgString, formatMode);

            if (properties['xmlDeclaration']) {
                if (!formatted.startsWith('<?xml')) {
                    formatted = '<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted;
                }
            }

            const bytes = new TextEncoder().encode(formatted);
            await writeBytes(path, bytes);

            return {
                Success: true,
                Info: recordToTable({
                    status: 'ok',
                    path,
                    bytes: bytes.length,
                    format: formatMode
                })
            };
        } catch (err) {
            console.error('Failed to write SVG:', err);
            return { Success: false, Info: errorTable(err) };
        }
    }
}
