import { zipSync, unzipSync, strToU8 } from 'fflate';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { WorkspaceFile } from '../types';
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_TEXT_SIZE = 5 * 1024 * 1024;
export function normalizePath(path: string): string {
  if (typeof path !== 'string') throw new Error('文件路径必须是文字。');
  const p = path.replace(/\\/g, '/');
  if (
    !p ||
    p.startsWith('/') ||
    /^[a-z]:/i.test(p) ||
    /[\x00-\x1f]/.test(p) ||
    p.split('/').some((s) => s === '..')
  )
    throw new Error('只能访问本地工作区内的相对路径，不能访问系统文件。');
  const normalized = p
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
  if (!normalized || normalized.length > 500) throw new Error('文件路径无效或过长。');
  return normalized;
}
export function textFile(path: string, content: string): WorkspaceFile {
  if (typeof content !== 'string') throw new Error('文件内容必须是文字。');
  const size = new TextEncoder().encode(content).byteLength;
  if (size > MAX_TEXT_SIZE) throw new Error('文本文件最大为 5 MB，请拆分后处理。');
  return {
    path: normalizePath(path),
    content,
    kind: 'text',
    mime: 'text/plain',
    size,
    updatedAt: Date.now(),
  };
}
const imageTypes = /\.(png|jpe?g|webp|gif)$/i;
const textTypes =
  /\.(txt|md|mdx|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|less|[cm]?jsx?|tsx?|py|go|rs|java|c|cpp|h|sh|sql|svg|ini|log|env|gitignore|vue|svelte|r|tex)$/i;
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768)
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${mime};base64,${btoa(s)}`;
}
export function dataUrlToBytes(url: string): Uint8Array {
  return Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
}
export async function importFile(
  file: File,
  path = file.webkitRelativePath || file.name,
): Promise<WorkspaceFile> {
  path = normalizePath(path);
  if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name} 超过 50 MB，请拆分后导入。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || 'application/octet-stream';
  const base = { path, mime, size: file.size, updatedAt: Date.now() };
  if (imageTypes.test(path)) {
    const type = /\.png$/i.test(path)
      ? 'image/png'
      : /\.webp$/i.test(path)
        ? 'image/webp'
        : /\.gif$/i.test(path)
          ? 'image/gif'
          : 'image/jpeg';
    return {
      ...base,
      mime: type,
      kind: 'image',
      content: '',
      dataUrl: bytesToDataUrl(bytes, type),
    };
  }
  if (/\.pdf$/i.test(path)) {
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      let content = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const text = await page.getTextContent();
        content +=
          `\n--- 第 ${i} 页 ---\n` +
          text.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('');
        if (content.length > MAX_TEXT_SIZE) throw new Error('PDF 提取的文本超过 5 MB。');
      }
      return {
        ...base,
        kind: 'binary',
        content: content.trim() || '（该 PDF 未包含可提取文字。请将扫描页以图片形式附加到消息。）',
        dataUrl: bytesToDataUrl(bytes, mime),
      };
    } finally {
      await task.destroy();
    }
  }
  if (/\.docx$/i.test(path)) {
    const entries = safeUnzip(bytes);
    const document = entries['word/document.xml'];
    if (!document) throw new Error('DOCX 文件缺少正文。');
    const xml = new DOMParser().parseFromString(
      new TextDecoder().decode(document),
      'application/xml',
    );
    if (xml.getElementsByTagName('parsererror').length)
      throw new Error('DOCX 正文格式损坏，无法解析。');
    const content = Array.from(xml.getElementsByTagName('w:p'))
      .map((p) =>
        Array.from(p.getElementsByTagName('w:t'))
          .map((t) => t.textContent)
          .join(''),
      )
      .join('\n');
    return { ...base, kind: 'binary', content, dataUrl: bytesToDataUrl(bytes, mime) };
  }
  const isText =
    textTypes.test(path) ||
    mime.startsWith('text/') ||
    (!bytes.includes(0) && !/\.[^/]+$/.test(path));
  if (isText) {
    if (file.size > MAX_TEXT_SIZE) throw new Error(`${file.name} 文本超过 5 MB。`);
    return {
      ...base,
      kind: 'text',
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  }
  return { ...base, kind: 'binary', content: '', dataUrl: bytesToDataUrl(bytes, mime) };
}
function safeUnzip(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0,
    count = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name.endsWith('/')) return false;
      normalizePath(entry.name);
      if (
        ++count > 2500 ||
        entry.originalSize > MAX_FILE_SIZE ||
        (total += entry.originalSize) > 100 * 1024 * 1024
      )
        throw new Error('压缩包解压后过大或文件过多。');
      return true;
    },
  });
}
export async function importZip(file: File): Promise<WorkspaceFile[]> {
  if (file.size > MAX_FILE_SIZE) throw new Error('压缩包最大为 50 MB。');
  const entries = safeUnzip(new Uint8Array(await file.arrayBuffer()));
  const result: WorkspaceFile[] = [];
  for (const [path, data] of Object.entries(entries))
    result.push(await importFile(new File([data.slice().buffer], path), path));
  return result;
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function downloadFile(file: WorkspaceFile) {
  downloadBlob(
    new Blob([file.dataUrl ? dataUrlToBytes(file.dataUrl).slice().buffer : file.content], {
      type: file.mime,
    }),
    file.path.split('/').pop()!,
  );
}
export function exportFiles(files: WorkspaceFile[]) {
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const f of files)
    entries[normalizePath(f.path)] = f.dataUrl ? dataUrlToBytes(f.dataUrl) : strToU8(f.content);
  downloadBlob(
    new Blob([zipSync(entries).slice().buffer], { type: 'application/zip' }),
    'localdesk-files.zip',
  );
}
