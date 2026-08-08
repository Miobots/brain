import { extname } from 'node:path';
import type { FilePart } from 'ai';
import type { Attachment } from '../types.js';
import { resolveImage } from './image.js';
import { resolvePdf } from './pdf.js';
import { resolveAudio } from './audio.js';

function nameOf(a: Attachment): string | undefined {
  if ('path' in a.source) return a.source.path;
  if ('url' in a.source) return a.source.url;
  return a.source.filename;
}

function kindOf(a: Attachment): 'image' | 'pdf' | 'audio' {
  const mediaType = a.mediaType;
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType?.startsWith('audio/')) return 'audio';

  const ext = extname(nameOf(a) ?? '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.wav', '.mp3', '.m4a', '.ogg'].includes(ext)) return 'audio';
  return 'image'; // default — covers .png/.jpg/.webp/.gif and any unrecognized extension
}

export async function resolveAttachment(a: Attachment): Promise<FilePart> {
  switch (kindOf(a)) {
    case 'image':
      return resolveImage(a);
    case 'pdf':
      return resolvePdf(a);
    case 'audio':
      return resolveAudio(a);
  }
}

export function resolveAttachments(attachments: Attachment[] | undefined): Promise<FilePart[]> {
  return Promise.all((attachments ?? []).map(resolveAttachment));
}

// New attachment kind later (e.g. a robotics/sensor file): add a resolveX.ts here,
// add one branch to kindOf(), done — nothing else in the AI layer changes.
//note to jalal ^