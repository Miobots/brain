import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf'
import type { FilePart } from 'ai';
import type { Attachment } from '../types.js';

async function loadPdfBytes(a: Attachment): Promise<Uint8Array> {
  if ('path' in a.source) {
    return await readFile(a.source.path);
  }
  if ('url' in a.source) {
    const res = await fetch(a.source.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch PDF (${res.status} ${res.statusText}): ${a.source.url}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  const { data } = a.source;
  return typeof data === 'string' ? Buffer.from(data, 'base64') : data;
}

function filenameFor(a: Attachment): string | undefined {
  if ('path' in a.source) return a.source.path.split('/').pop();
  if ('url' in a.source) return a.source.url.split('/').pop();
  return a.source.filename;
}

export async function resolvePdf(a: Attachment, opts: { includeRawFile: boolean }): Promise<FilePart[]> {
  const bytes = await loadPdfBytes(a);
  const filename = filenameFor(a);
  const parts: FilePart[] = [];

  if (opts.includeRawFile) {
    parts.push({
      type: 'file',
      data: bytes,
      filename,
      mediaType: 'application/pdf',
    });
  }

  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });

  parts.push({
    type: 'file',
    data: Buffer.from(text, 'utf8'),
    filename: filename ? `${filename}.txt` : undefined,
    mediaType: 'text/plain',
  });

  return parts;
}

// Now resolve pdf takes as input includeRawfile boolean 
// if its true it pushes raw bytes for providers that do accept direct pdfs
// for those that dont we extract text and convert to utf-8 as per Filepart docs
