// Minimal type shim for archiver v8 (no official @types yet, package ships no
// .d.ts of its own). Only the surface we actually use is declared.
declare module 'archiver' {
  import { Transform } from 'node:stream';
  import type { ZlibOptions } from 'node:zlib';

  export interface CoreOptions {
    highWaterMark?: number;
    statConcurrency?: number;
    zlib?: ZlibOptions;
  }

  export interface EntryData {
    name?: string;
    date?: Date | string;
    mode?: number;
    prefix?: string;
  }

  export class Archiver extends Transform {
    constructor(options?: CoreOptions);
    pointer(): number;
    append(source: Buffer | string | NodeJS.ReadableStream | null, data?: EntryData): this;
    directory(dirpath: string, destpath?: string | false, data?: EntryData): this;
    file(filepath: string, data?: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    on(event: 'error' | 'warning', listener: (err: Error & { code?: string }) => void): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end' | 'close' | 'finish', listener: () => void): this;
    on(event: 'entry', listener: (entry: unknown) => void): this;
    on(event: 'progress', listener: (progress: unknown) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
  }

  export class ZipArchive extends Archiver {}
  export class TarArchive extends Archiver {}
  export class JsonArchive extends Archiver {}
}
