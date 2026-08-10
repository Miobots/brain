import { extname } from 'node:path';
import type { FilePart } from 'ai';
import type { Attachment } from '../types.js';
import type { ProviderKind } from '../config.js';
import { supportsNativeFile } from '../providers/capabilities.js';
import { resolveImage,guessImageMediaType } from './image.js';
import { resolvePdf } from './pdf.js';
import { resolveAudio , guessAudioMediaType} from './audio.js';

function nameOf(a: Attachment): string | undefined {
  if ('path' in a.source) return a.source.path;
  if ('url' in a.source) return a.source.url;
  return a.source.filename;
}

export function kindOf(a: Attachment): 'image' | 'pdf' | 'audio' {
  const mediaType = a.mediaType;
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType?.startsWith('audio/')) return 'audio';

  const name = nameOf(a) ?? '';
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (guessAudioMediaType(name)) return 'audio';
  if (guessImageMediaType(name)) return 'image';
//now throws an error for unrecognized media type based on EXT in images and audio.ts
  throw new Error(
    `Cannot determine attachment kind for "${name || '(unnamed)'}"` +
      (mediaType ? ` — unrecognized mediaType "${mediaType}"` : ext ? ` — unrecognized extension "${ext}"` : ' — no mediaType or filename to infer from'),
  );
}

export async function resolveAttachment(a: Attachment, providerKind: ProviderKind): Promise<FilePart[]> {
  switch (kindOf(a)) {
    case 'image':
      return [await resolveImage(a)];
    case 'pdf':
      return resolvePdf(a, { includeRawFile: supportsNativeFile(providerKind, 'application/pdf') });
    case 'audio':
      return [await resolveAudio(a)];
  }
}

export async function resolveAttachments(
  attachments: Attachment[] | undefined,
  providerKind: ProviderKind,
): Promise<FilePart[]> {
  const resolved = await Promise.all(
    (attachments ?? []).map(a => resolveAttachment(a, providerKind)),
  );
  return resolved.flat();
}

// New attachment kind later (e.g. a robotics/sensor file): add a resolveX.ts here,
// add one branch to kindOf(), wrap its result in an array in the switch above, done.
// If the new kind also needs capability-based branching (like pdf), give it the
// same (a, providerKind) signature and an opts object — follow pdf.ts as the template.
