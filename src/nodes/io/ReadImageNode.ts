import { ExecuteNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { decodeFile } from '../../codecs/registry';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { readBytes } from '../../io/files';
import { describeImage } from '../../model/image';

const IMAGE_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'avif',
    'heic', 'heif', 'hif', 'tif', 'tiff', 'fits', 'fit', 'fts', 'gz'
];

export class ReadImageNode extends ExecuteNode {
    readonly typeId = 'images.read';
    readonly displayName = 'Read Image';
    readonly category = ImagesCategory;
    readonly visible = true;

    readonly inputs: InputDefinition[] = [
        { name: 'Path', acceptsType: ['core:path', 'core:string'] }
    ];

    readonly outputs: OutputDefinition[] = [
        { name: 'Image', outputType: 'images:image' },
        { name: 'Frames', outputType: 'images:image-array' },
        { name: 'Path', outputType: 'core:path' },
        { name: 'Info', outputType: 'core:dataframe' }
    ];

    readonly properties: PropertyDefinition[] = [
        {
            name: 'filePath',
            label: 'File path',
            type: 'filepath',
            defaultValue: '',
            filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
        },
        {
            name: 'frame',
            label: 'Frame',
            type: 'number',
            defaultValue: 0,
            min: 0,
            step: 1
        }
    ];

    private async readSingle(filePath: string, requestedFrame: number) {
        const bytes = await readBytes(filePath);
        const decoded = await decodeFile(bytes, { path: filePath });
        const requested = Math.floor(requestedFrame || 0);
        const index = Math.min(Math.max(requested, 0), decoded.images.length - 1);
        const image = decoded.images[index];
        image.meta.source = { ...image.meta.source, format: image.meta.source?.format ?? 'unknown', path: filePath, frame: index };
        return { image, decoded, path: filePath };
    }

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const rawPath = inputs['Path'] ?? properties['filePath'];
        if (!rawPath) return {};

        const frameProp = Number(properties['frame']) || 0;

        if (Array.isArray(rawPath)) {
            const paths = rawPath.map(p => String(p)).filter(Boolean);
            if (paths.length === 0) return {};

            const settled = await Promise.allSettled(paths.map(p => this.readSingle(p, frameProp)));
            const succeeded: Array<{ image: any; decoded: any; path: string }> = [];
            const failed: Array<{ path: string; reason: string }> = [];

            settled.forEach((res, idx) => {
                if (res.status === 'fulfilled') {
                    succeeded.push(res.value);
                } else {
                    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
                    failed.push({ path: paths[idx], reason });
                    console.error(`Failed to read image '${paths[idx]}':`, res.reason);
                }
            });

            if (succeeded.length === 0) {
                return { Info: errorTable(failed[0]?.reason ?? 'Failed to read images.') };
            }

            const images = succeeded.map(r => r.image);
            const frames = succeeded.map(r => r.decoded.images);
            const okPaths = succeeded.map(r => r.path);
            const first = succeeded[0];
            const info: Record<string, unknown> = {
                count: images.length,
                ...first.decoded.info,
                ...describeImage(images[0])
            };
            if (failed.length > 0) {
                info.failed = failed.length;
                info.failedPaths = failed.map(f => f.path).join(', ');
            }

            return {
                Image: images,
                Frames: frames,
                Path: okPaths,
                Info: recordToTable(info)
            };
        }

        const path = String(rawPath);
        try {
            const { image, decoded } = await this.readSingle(path, frameProp);
            return {
                Image: image,
                Frames: decoded.images,
                Path: path,
                Info: recordToTable({ ...decoded.info, frames: decoded.images.length, ...describeImage(image) })
            };
        } catch (err) {
            console.error('Failed to read image:', err);
            return { Info: errorTable(err) };
        }
    }
}
