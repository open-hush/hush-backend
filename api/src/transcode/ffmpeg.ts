import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TranscodeResult {
  outputPath: string;
  sizeBytes: number;
  sha256Hex: string;
  durationMs: number;
}

/**
 * Build the ffmpeg argv to encode an input file to MP3 128 kbps CBR mono 44.1 kHz.
 * Exposed for testing.
 */
export function buildFfmpegArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '44100',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-f',
    'mp3',
    outputPath,
  ];
}

export interface TranscodeOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Override temp dir for tests. */
  workDir?: string;
}

export async function transcodeToMp3(
  inputPath: string,
  opts: TranscodeOptions = {},
): Promise<TranscodeResult> {
  const ffmpegPath = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobePath = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';

  const work = await mkdtemp(join(opts.workDir ?? tmpdir(), 'hush-transcode-'));
  const outputPath = join(work, 'out.mp3');

  try {
    await runFfmpeg(ffmpegPath, buildFfmpegArgs(inputPath, outputPath));
    const [{ size }, sha256Hex, durationMs] = await Promise.all([
      stat(outputPath),
      sha256OfFile(outputPath),
      probeDurationMs(ffprobePath, outputPath),
    ]);
    return { outputPath, sizeBytes: size, sha256Hex, durationMs };
  } catch (err) {
    await rm(work, { recursive: true, force: true });
    throw err;
  }
}

/** Cleanup helper for callers that have consumed `outputPath`. */
export async function cleanupTranscodeOutput(outputPath: string): Promise<void> {
  await rm(outputPath, { force: true });
  // The mkdtemp dir is the parent; drop it too.
  await rm(join(outputPath, '..'), { recursive: true, force: true });
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function probeDurationMs(bin: string, file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`));
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds)) return reject(new Error(`ffprobe gave non-numeric duration: ${stdout.trim()}`));
      resolve(Math.round(seconds * 1000));
    });
  });
}

async function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
