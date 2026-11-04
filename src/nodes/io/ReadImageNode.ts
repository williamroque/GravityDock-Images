import { ExecuteNode } from '@gravitydock/types';
import type { InputDefinition, OutputDefinition, PropertyDefinition } from '@gravitydock/types';
import { ImagesCategory } from '../../categories';
import { decodeFile } from '../../codecs/registry';
import { errorTable, recordToTable } from '../../interop/dataframe';
import { readBytes } from '../../io/files';
import { describeImage } from '../../model/image';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'fits', 'fit', 'fts', 'gz'];

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
        return { image, decoded };
    }

    async evaluate(inputs: Record<string, any>, properties: Record<string, any>): Promise<Record<string, any>> {
        const rawPath = inputs['Path'] ?? properties['filePath'];
        if (!rawPath) return {};

        const frameProp = Number(properties['frame']) || 0;

        if (Array.isArray(rawPath)) {
            const paths = rawPath.map(p => String(p)).filter(Boolean);
            if (paths.length === 0) return {};
            try {
                const results = await Promise.all(paths.map(p => this.readSingle(p, frameProp)));
                const images = results.map(r => r.image);
                const frames = results.map(r => r.decoded.images);
                const first = results[0];
                return {
                    Image: images,
                    Frames: frames,
                    Path: paths,
                    Info: recordToTable({
                        count: images.length,
                        ...first?.decoded.info,
                        ...describeImage(images[0])
                    })
                };
            } catch (err) {
                console.error('Failed to read images:', err);
                return { Info: errorTable(err) };
            }
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
