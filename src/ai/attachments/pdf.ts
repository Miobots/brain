import { readFile } from 'node:fs/promises';
import type { FilePart } from 'ai';
import type { Attachment } from '../types.js';



export async function resolvePdf(a: Attachment): Promise<FilePart> {
  if ('path' in a.source) {
    const data = await readFile(a.source.path);
    return {
      type: 'file',
      data,
      filename: a.source.path.split('/').pop(),
      mediaType: 'application/pdf',
    };
  }
  if ('url' in a.source) {
    return { type: 'file', data: new URL(a.source.url), mediaType: 'application/pdf' };
  }
  return {
    type: 'file',
    data: a.source.data,
    filename: a.source.filename,
    mediaType: 'application/pdf',
  };
}

// Note for jalal : No text extraction because models except pdfs as bytes directly
//those who dont we can implement text extraction for those others
//throw and invalid_request if they dont support