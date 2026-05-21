import { describe, expect, it } from 'vitest';

import { buildFfmpegArgs } from '../src/transcode/ffmpeg.js';

describe('buildFfmpegArgs', () => {
  it('targets MP3 128 kbps CBR mono 44.1 kHz', () => {
    const args = buildFfmpegArgs('/in', '/out.mp3');
    expect(args).toContain('-vn');
    expect(args).toContain('libmp3lame');
    expect(args).toContain('-b:a');
    expect(args[args.indexOf('-b:a') + 1]).toBe('128k');
    expect(args[args.indexOf('-ar') + 1]).toBe('44100');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args.at(-1)).toBe('/out.mp3');
    expect(args[args.indexOf('-i') + 1]).toBe('/in');
  });

  it('uses -y to overwrite output', () => {
    expect(buildFfmpegArgs('in', 'out')).toContain('-y');
  });
});
