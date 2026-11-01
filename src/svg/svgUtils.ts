import { readBytes } from '../io/files';

export const DEFAULT_CSS_VARS: Record<string, string> = {
    '--theme-plotBackgroundColor': 'transparent',
    '--primary-color': '#3b82f6',
    '--primary-color-subdued': 'rgba(59, 130, 246, 0.2)',
    '--primary-highlight-color': 'rgba(59, 130, 246, 0.1)',
    '--secondary-color': '#6b7280',
    '--tertiary-color': '#374151',
    '--text-color': '#f3f4f6',
    '--secondary-text-color': '#9ca3af',
    '--background-color': '#111827',
    '--border-color': '#374151',
    '--glass-background-color': 'rgba(255, 255, 255, 0.05)'
};

export function resolveCssVarsInSvg(svgEl: Element): void {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    const cache = new Map<string, string>();

    const resolve = (val: string): string => {
        return val.replace(/var\((--[^,)]+)(?:,\s*([^)]+))?\)/g, (_, varName: string, fallback: string) => {
            const key = varName.trim();
            if (!cache.has(key)) {
                const computed = root ? getComputedStyle(root).getPropertyValue(key).trim() : '';
                const resolved = computed || fallback?.trim() || DEFAULT_CSS_VARS[key] || 'inherit';
                cache.set(key, resolved);
            }
            return cache.get(key) || fallback?.trim() || 'inherit';
        });
    };

    const walk = (el: Element) => {
        let inlineStyle = el.getAttribute('style');
        if (inlineStyle) {
            if (inlineStyle.includes('var(')) inlineStyle = resolve(inlineStyle);
            if (inlineStyle.includes('#00000000')) inlineStyle = inlineStyle.replace(/#00000000/g, 'transparent');
            el.setAttribute('style', inlineStyle);
        }

        const presentationAttrs = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'];
        for (const attr of presentationAttrs) {
            let val = el.getAttribute(attr);
            if (val) {
                if (val.includes('var(')) val = resolve(val);
                if (val === '#00000000' || val === 'transparent') val = 'none';
                el.setAttribute(attr, val);
            }
        }

        for (const child of Array.from(el.children)) {
            walk(child);
        }
    };

    walk(svgEl);

    const styleTags = svgEl.querySelectorAll('style');
    for (const tag of Array.from(styleTags)) {
        if (tag.textContent && tag.textContent.includes('var(')) {
            tag.textContent = resolve(tag.textContent);
        }
    }
}

export function parseLength(val: string | null): number | null {
    if (!val) return null;
    const trimmed = val.trim();
    if (!trimmed || trimmed.endsWith('%')) return null;
    const num = parseFloat(trimmed);
    if (!Number.isFinite(num) || num <= 0) return null;
    if (trimmed.endsWith('pt')) return num * (96 / 72);
    if (trimmed.endsWith('pc')) return num * 16;
    if (trimmed.endsWith('mm')) return num * 3.7795275591;
    if (trimmed.endsWith('cm')) return num * 37.795275591;
    if (trimmed.endsWith('in')) return num * 96;
    return num;
}

export function parseViewBox(svgEl: Element): { x: number; y: number; width: number; height: number } | null {
    const vb = svgEl.getAttribute('viewBox');
    if (!vb) return null;
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
        return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
    return null;
}

export function parseBackgroundColor(raw: unknown): string {
    if (!raw || typeof raw !== 'string') return 'transparent';
    let s = raw.trim();
    if (s.startsWith('custom:')) s = s.substring(7).trim();
    if (s.startsWith('theme:')) return 'transparent';
    if (s === '#00000000' || s === 'none' || s === 'transparent') return 'transparent';
    return s;
}

export async function extractSvgString(raw: unknown): Promise<string | null> {
    if (raw === null || raw === undefined) return null;

    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('data:image/svg+xml')) {
            const commaIndex = trimmed.indexOf(',');
            if (commaIndex !== -1) {
                const header = trimmed.substring(0, commaIndex);
                const data = trimmed.substring(commaIndex + 1);
                if (header.includes(';base64')) {
                    try {
                        return atob(data);
                    } catch {
                        return null;
                    }
                }
                return decodeURIComponent(data);
            }
        }
        if (trimmed.includes('<svg')) {
            const start = trimmed.indexOf('<svg');
            const end = trimmed.lastIndexOf('</svg>');
            if (end !== -1) {
                return trimmed.substring(start, end + 6);
            }
            return trimmed.substring(start);
        }
        if (trimmed.endsWith('.svg') || trimmed.includes('/') || trimmed.includes('\\')) {
            try {
                const bytes = await readBytes(trimmed);
                return new TextDecoder('utf-8').decode(bytes);
            } catch {
                return null;
            }
        }
        return null;
    }

    if (raw instanceof Uint8Array || ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
        const text = new TextDecoder('utf-8').decode(raw as Uint8Array);
        if (text.includes('<svg')) return text;
        return null;
    }

    if (typeof raw === 'object') {
        const obj = raw as Record<string, any>;
        if (obj.type === 'core:svg' && typeof obj.content === 'string') {
            return obj.content;
        }
        if (obj.Render) {
            const nested = await extractSvgString(obj.Render);
            if (nested) return nested;
        }
        if (typeof obj.content === 'string' && obj.content.includes('<svg')) {
            return obj.content;
        }
        if (typeof obj.svg === 'string') {
            return obj.svg;
        }
        if (typeof obj.xml === 'string') {
            return obj.xml;
        }
    }

    return null;
}

export function parseSvgDocument(svgString: string): { doc: Document; svgEl: Element } {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
        throw new Error(`SVG parse error: ${parserError.textContent}`);
    }

    let svgEl = doc.documentElement;
    if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
        const found = doc.querySelector('svg');
        if (!found) throw new Error('No <svg> root element found in content.');
        svgEl = found;
    }

    if (!svgEl.getAttribute('xmlns')) {
        svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if (!svgEl.getAttribute('xmlns:xlink') && svgString.includes('xlink:')) {
        svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }

    return { doc, svgEl };
}

export function serializeSvgDocument(svgEl: Element): string {
    const serializer = new XMLSerializer();
    return serializer.serializeToString(svgEl);
}

export function resolveDimensions(svgEl: Element): { width: number; height: number; viewBox: { x: number; y: number; width: number; height: number } | null } {
    const vb = parseViewBox(svgEl);
    const attrW = parseLength(svgEl.getAttribute('width'));
    const attrH = parseLength(svgEl.getAttribute('height'));

    const width = attrW ?? vb?.width ?? 300;
    const height = attrH ?? vb?.height ?? 150;

    return { width, height, viewBox: vb };
}

export function formatSvg(svgString: string, mode: 'raw' | 'pretty' | 'minified'): string {
    if (mode === 'raw') return svgString;
    if (mode === 'minified') {
        return svgString
            .replace(/\s+/g, ' ')
            .replace(/>\s+</g, '><')
            .trim();
    }
    let formatted = '';
    let indent = 0;
    const tokens = svgString.replace(/>\s*</g, '><').split(/(?=<)|(?<=>)/);
    for (const token of tokens) {
        const trimmed = token.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('</')) {
            indent = Math.max(0, indent - 1);
            formatted += '  '.repeat(indent) + trimmed + '\n';
        } else if (trimmed.startsWith('<') && !trimmed.endsWith('/>') && !trimmed.startsWith('<?') && !trimmed.startsWith('<!')) {
            formatted += '  '.repeat(indent) + trimmed + '\n';
            if (!trimmed.includes('</')) indent++;
        } else {
            formatted += '  '.repeat(indent) + trimmed + '\n';
        }
    }
    return formatted.trim();
}
