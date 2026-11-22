import { browserCodecs } from './browser';
import { fitsCodec } from './fits/fitsCodec';
import { heicCodec } from './heic';
import { pngCodec } from './png';
import { registerCodec } from './registry';

export function registerBuiltinCodecs(): void {
    registerCodec(fitsCodec);
    registerCodec(pngCodec);
    registerCodec(heicCodec);
    for (const codec of browserCodecs) registerCodec(codec);
}
