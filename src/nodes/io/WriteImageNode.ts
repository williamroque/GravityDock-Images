import { ExecuteNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { codecForExtension, extensionOf, getCodec } from '../../codecs/registry';
import { prepareForEncode, type MismatchPolicy } from '../../core/convert';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { writeBytes } from '../../io/files';
import { isImage, type TRImage } from '../../model/image';

export class WriteImageNode extends ExecuteNode {
    readonly typeId = 'images.write';
    readonly displayName = 'Write Image';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'Image', acceptsType: 'images:image' },
        { name: 'Path', acceptsType: ['core:path', 'core:string'] }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Success', outputType: 'core:boolean' },
        { name: 'Info', outputType: 'core:dataframe' }
    ];

    readonly properties: PropertyDefinition[] = [
        { name: 'filePath', label: 'Output file path', type: 'filepath', defaultValue: '' },
        {
            name: 'format',
            label: 'Format',
            type: 'select',
            defaultValue: 'auto',
            options: [
                { label: 'Auto (from extension)', value: 'auto' },
                { label: 'FITS', value: 'fits' },
                { label: 'PNG', value: 'png' },
                { label: 'JPEG', value: 'jpeg' },
                { label: 'WebP', value: 'webp' }
            ]
        },
        { name: 'quality', label: 'Quality (lossy formats)', type: 'number', defaultValue: 0.92, min: 0.01, step: 0.01 },
        {
            name: 'onMismatch',
            label: 'If the format cannot hold the pixels',
            type: 'select',
            defaultValue: 'auto',
            options: [
                { label: 'Auto (scale by known range)', value: 'auto' },
                { label: 'Fail', value: 'error' },
                { label: 'Normalize (min/max)', value: 'normalize' },
                { label: 'Clamp', value: 'clamp' }
            ]
        }
    ];

    private resolveTargetFilePath(
        basePath: string,
        image: TRImage,
        index: number,
        total: number,
        pathWasVectorized: boolean,
        defaultFormat: string
    ): string {
        const rawBasePath = basePath ? basePath.trim() : '';
        const srcPath = image.meta?.source?.path || '';
        const srcExt = extensionOf(srcPath);
        const srcBase = srcPath ? (srcPath.split(/[/\\]/).pop() || '').replace(/\.[^.]+$/, '') : 'image';

        const outExt = defaultFormat !== 'auto'
            ? (defaultFormat === 'jpeg' ? 'jpg' : defaultFormat)
            : (extensionOf(rawBasePath) || srcExt || 'png');

        if (rawBasePath && (rawBasePath.includes('{index}') || rawBasePath.includes('{i}') || rawBasePath.includes('{name}') || rawBasePath.includes('{basename}') || rawBasePath.includes('{ext}'))) {
            return rawBasePath
                .replace(/\{index\}/g, String(index + 1))
                .replace(/\{i\}/g, String(index))
                .replace(/\{name\}/g, srcBase)
                .replace(/\{basename\}/g, srcBase)
                .replace(/\{ext\}/g, outExt);
        }

        if (!rawBasePath) {
            if (!srcPath) return `image_${index + 1}.${outExt}`;
            const dotIdx = srcPath.lastIndexOf('.');
            const slashIdx = Math.max(srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\'));
            const stem = dotIdx > slashIdx ? srcPath.slice(0, dotIdx) : srcPath;
            return `${stem}.${outExt}`;
        }

        const dotIdx = rawBasePath.lastIndexOf('.');
        const slashIdx = Math.max(rawBasePath.lastIndexOf('/'), rawBasePath.lastIndexOf('\\'));
        const isDirectory = rawBasePath.endsWith('/') || rawBasePath.endsWith('\\') || dotIdx <= slashIdx;

        if (isDirectory) {
            const cleanDir = rawBasePath.replace(/[/\\]+$/, '');
            const name = srcBase || `image_${index + 1}`;
            return `${cleanDir}/${name}.${outExt}`;
        }

        const stem = rawBasePath.slice(0, dotIdx);
        if (total > 1 && !pathWasVectorized) {
            return `${stem}_${index + 1}.${outExt}`;
        }

        return `${stem}.${outExt}`;
    }

    private async writeSingleImage(
        image: TRImage,
        targetPath: string,
        properties: Record<string, any>
    ): Promise<{ path: string; format: string; bytes: number; notes: string[] }> {
        const requested = String(properties['format'] || 'auto');
        const codec = requested === 'auto' ? codecForExtension(targetPath) : getCodec(requested);
        if (!codec) throw new Error(`Cannot infer the output format for '${targetPath}'. Use a known file extension or choose a format.`);
        if (!codec.encode) throw new Error(`${codec.label} export is not supported.`);

        const policy = String(properties['onMismatch'] || 'auto') as MismatchPolicy;
        const prepared = prepareForEncode(image, codec.capabilities, policy, codec.label);
        const bytes = await codec.encode([prepared.image], { quality: Number(properties['quality']) });
        await writeBytes(targetPath, bytes);

        return {
            path: targetPath,
            format: codec.id,
            bytes: bytes.length,
            notes: prepared.notes
        };
    }

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const rawImage = inputs['Image'];
        const rawPath = inputs['Path'] ?? properties['filePath'];

        const vectorIndex = typeof inputs['_vectorIndex'] === 'number' ? inputs['_vectorIndex'] : 0;
        const vectorLength = typeof inputs['_vectorLength'] === 'number' ? inputs['_vectorLength'] : 1;
        const vectorInputs: string[] = Array.isArray(inputs['_vectorInputs']) ? inputs['_vectorInputs'] : [];
        const pathWasVectorized = vectorInputs.includes('Path');
        const requestedFormat = String(properties['format'] || 'auto');

        if (Array.isArray(rawImage)) {
            const images = rawImage.filter(isImage);
            if (images.length === 0) return { Success: false };

            const pathList: string[] = Array.isArray(rawPath) ? rawPath.map(p => String(p)) : [];
            const results: { path: string; format: string; bytes: number; notes: string[] }[] = [];

            try {
                for (let i = 0; i < images.length; i++) {
                    const img = images[i];
                    const basePath = pathList[i] || (typeof rawPath === 'string' ? rawPath : '');
                    const targetPath = this.resolveTargetFilePath(
                        basePath,
                        img,
                        i,
                        images.length,
                        pathList.length > 0,
                        requestedFormat
                    );
                    if (!targetPath) continue;
                    const res = await this.writeSingleImage(img, targetPath, properties);
                    results.push(res);
                }

                return {
                    Success: results.length === images.length,
                    Info: recordToTable({
                        status: 'ok',
                        written: results.length,
                        paths: results.map(r => r.path).join(', ')
                    })
                };
            } catch (err) {
                console.error('Failed to write images:', err);
                return { Success: false, Info: errorTable(err) };
            }
        }

        if (!isImage(rawImage)) return {};

        const basePath = typeof rawPath === 'string' ? rawPath : '';
        const targetPath = this.resolveTargetFilePath(
            basePath,
            rawImage,
            vectorIndex,
            vectorLength,
            pathWasVectorized,
            requestedFormat
        );
        if (!targetPath) return { Success: false };

        try {
            const res = await this.writeSingleImage(rawImage, targetPath, properties);
            const record: Record<string, unknown> = {
                status: 'ok',
                path: res.path,
                format: res.format,
                bytes: res.bytes
            };
            res.notes.forEach((note, i) => { record[`conversion ${i + 1}`] = note; });
            return { Success: true, Info: recordToTable(record) };
        } catch (err) {
            console.error('Failed to write image:', err);
            return { Success: false, Info: errorTable(err) };
        }
    }
}
