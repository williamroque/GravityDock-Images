import type { GravityDockAPI } from '@gravitydock/types';
import { fromBinaryString } from '../interop/base64';

declare const gravityDock: GravityDockAPI;

function toBytes(raw: any): Uint8Array {
    if (typeof raw === 'string') return fromBinaryString(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (Object.prototype.toString.call(raw) === '[object ArrayBuffer]') return new Uint8Array(raw);
    if (raw && raw.type === 'Buffer' && Array.isArray(raw.data)) return Uint8Array.from(raw.data);
    throw new Error('Unexpected file data returned by the host.');
}

export async function readBytes(path: string): Promise<Uint8Array> {
    const raw = await gravityDock.fs.readFile(path, null as any);
    return toBytes(raw);
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await gravityDock.fs.writeFile(path, bytes);
}

export async function decodeNativeImage(
    bytes: Uint8Array,
    options?: { path?: string; extension?: string }
): Promise<Uint8Array | null> {
    const imageApi = (gravityDock as any).image;
    if (!imageApi || typeof imageApi.decodeNative !== 'function') return null;
    try {
        const raw = await imageApi.decodeNative({
            bytes,
            path: options?.path,
            extension: options?.extension
        });
        if (!raw) return null;
        const out = toBytes(raw);
        return out.length > 0 ? out : null;
    } catch {
        return null;
    }
}
