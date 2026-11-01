import type { GravityDockAPI } from '@gravitydock/types';
import { registerBuiltinCodecs } from './codecs';
import { initRuntime } from './runtime';
import { unwrapInputs, wrapOutputs } from './transport';
import { ReadImageNode } from './nodes/io/ReadImageNode';
import { WriteImageNode } from './nodes/io/WriteImageNode';
import { ImageInfoNode } from './nodes/io/ImageInfoNode';
import { ShowImageNode } from './nodes/display/ShowImageNode';
import { ConvertTypeNode } from './nodes/convert/ConvertTypeNode';
import { ToGrayscaleNode } from './nodes/convert/ToGrayscaleNode';
import { RasterizeNode } from './nodes/convert/RasterizeNode';
import { StretchNode } from './nodes/tone/StretchNode';
import { ColormapNode } from './nodes/tone/ColormapNode';
import { CropNode } from './nodes/geometry/CropNode';
import { ResizeNode } from './nodes/geometry/ResizeNode';
import { FlipNode } from './nodes/geometry/FlipNode';
import { RotateNode } from './nodes/geometry/RotateNode';
import { MontageNode } from './nodes/geometry/MontageNode';
import { GaussianBlurNode } from './nodes/filter/GaussianBlurNode';
import { ImageMathNode } from './nodes/math/ImageMathNode';
import { FITSHeaderNode } from './nodes/fits/FITSHeaderNode';
import { FITSTableNode } from './nodes/fits/FITSTableNode';
import { ReadSvgNode } from './nodes/svg/ReadSvgNode';
import { WriteSvgNode } from './nodes/svg/WriteSvgNode';
import { SvgInfoNode } from './nodes/svg/SvgInfoNode';
import { ImageToSvgNode } from './nodes/svg/ImageToSvgNode';
import { ComposeSvgNode } from './nodes/svg/ComposeSvgNode';
import { TransformSvgNode } from './nodes/svg/TransformSvgNode';
import { RenderSvgNode } from './nodes/svg/RenderSvgNode';

import { ImageThemeSections } from './themes';

declare const gravityDock: GravityDockAPI;

registerBuiltinCodecs();
void initRuntime();

const nodes = [
    new ReadImageNode(),
    new WriteImageNode(),
    new ImageInfoNode(),
    new ShowImageNode(),
    new ConvertTypeNode(),
    new ToGrayscaleNode(),
    new RasterizeNode(),
    new StretchNode(),
    new ColormapNode(),
    new CropNode(),
    new ResizeNode(),
    new FlipNode(),
    new RotateNode(),
    new MontageNode(),
    new GaussianBlurNode(),
    new ImageMathNode(),
    new FITSHeaderNode(),
    new FITSTableNode(),
    new ReadSvgNode(),
    new WriteSvgNode(),
    new SvgInfoNode(),
    new ImageToSvgNode(),
    new ComposeSvgNode(),
    new TransformSvgNode(),
    new RenderSvgNode()
];

const serializableNodes = nodes.map(n => ({
    typeId: n.typeId,
    displayName: n.displayName,
    nodeInterface: n.nodeInterface,
    category: n.category,
    visible: n.visible,
    packageId: n.packageId,
    inputs: n.inputs,
    outputs: n.outputs,
    properties: n.properties,
    dynamicInputs: n.dynamicInputs,
    dynamicOutputs: n.dynamicOutputs
}));

gravityDock.registerNodes(serializableNodes);
gravityDock.registerThemeSections(ImageThemeSections);

gravityDock.onEvaluateNode(async ({ typeId, inputs, properties }) => {
    const node = nodes.find(n => n.typeId === typeId);
    if (!node) {
        throw new Error(`Unknown node type: ${typeId}`);
    }
    const result = await node.evaluate(unwrapInputs(inputs) as Record<string, any>, properties);
    return wrapOutputs(result);
});
