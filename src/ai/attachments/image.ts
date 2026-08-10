import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FilePart } from 'ai';
import type { Attachment } from '../types.js';

//converts file extention to mimetype
const EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};


export function guessImageMediaType(name: string): string | undefined {
  return EXT[extname(name).toLowerCase()];
}
//returns a file part , resolves image that might be provided via , file path 
//url or already provided binary data 
export async function resolveImage(a: Attachment): Promise<FilePart> {
  if ('path' in a.source) {
    const data = await readFile(a.source.path);
    return {
      type: 'file',
      data,
      filename: a.source.path.split('/').pop(),
      mediaType: a.mediaType ?? guessImageMediaType(a.source.path) ?? 'image/png',
    };
  }
  if ('url' in a.source) {
    return { type: 'file', data: new URL(a.source.url), mediaType: a.mediaType ?? 'image/png' };
  }
  return {
    type: 'file',
    data: a.source.data,
    filename: a.source.filename,
    mediaType: a.mediaType ?? 'image/png',
  };
}