import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FilePart } from 'ai';
import type { Attachment } from '../types.js';

//converts file extention to mimetype
const EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

export function guessAudioMediaType(name: string): string | undefined {
  return EXT[extname(name).toLowerCase()];
}
//same functions as images
export async function resolveAudio(a: Attachment): Promise<FilePart> {
  if ('path' in a.source) {
    const data = await readFile(a.source.path);
    return {
      type: 'file',
      data,
      filename: a.source.path.split('/').pop(),
      mediaType: a.mediaType ?? guessAudioMediaType(a.source.path) ?? 'audio/wav',
    };
  }
  if ('url' in a.source) {
    return { type: 'file', data: new URL(a.source.url), mediaType: a.mediaType ?? 'audio/wav' };
  }
  return {
    type: 'file',
    data: a.source.data,
    filename: a.source.filename,
    mediaType: a.mediaType ?? 'audio/wav',
  };
}