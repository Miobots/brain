import { describe, it, expect } from 'vitest';
import { kindOf } from '../../../src/ai/attachments/resolve';
import type { Attachment } from '../../../src/ai/types';

describe('kindOf()', () => {
  it('recognizes image by mediaType', () => {
    const a: Attachment = { source: { data: new Uint8Array(), filename: 'x' }, mediaType: 'image/png' };
    expect(kindOf(a)).toBe('image');
  });

  it('recognizes pdf by mediaType and extension', () => {
    const a1: Attachment = { source: { data: new Uint8Array(), filename: 'doc' }, mediaType: 'application/pdf' };
    expect(kindOf(a1)).toBe('pdf');

    const a2: Attachment = { source: { data: new Uint8Array(), filename: 'report.PDF' } };
    expect(kindOf(a2)).toBe('pdf');
  });

  it('recognizes audio by mediaType and filename', () => {
    const a1: Attachment = { source: { data: new Uint8Array(), filename: 'sound' }, mediaType: 'audio/mpeg' };
    expect(kindOf(a1)).toBe('audio');

    const a2: Attachment = { source: { data: new Uint8Array(), filename: 'song.mp3' } };
    expect(kindOf(a2)).toBe('audio');
  });

  it('recognizes image by path or url extension', () => {
    const a1: Attachment = { source: { path: '/tmp/photo.JPG' } };
    expect(kindOf(a1)).toBe('image');

    const a2: Attachment = { source: { url: 'https://example.com/pic.png' } };
    expect(kindOf(a2)).toBe('image');
  });

  it('throws for unknown kinds', () => {
    const a: Attachment = { source: { data: new Uint8Array(), filename: 'file.unknown' } };
    expect(() => kindOf(a)).toThrow(/Cannot determine attachment kind/);
  });
});
