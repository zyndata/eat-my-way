import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reader: enough to pull a few named members out of the FoodData Central
 * archives, and no more. Node ships `zlib` but no archive reader, and pulling in a package
 * for a dev-time script the browser never sees is not worth it (STATE.md decision on
 * minimal dependencies). The FDC archives are plain 32-bit ZIPs using store or deflate.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** The end-of-central-directory record lives in the last 64 KiB, after a variable comment. */
function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0x10000 - 22);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('Not a ZIP archive: no end-of-central-directory record');
}

/**
 * Index the archive's central directory.
 * @returns {Map<string, {compression: number, compressedSize: number, size: number, localHeaderOffset: number}>}
 */
export function readZipIndex(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`Corrupt central directory at entry ${i}`);
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.set(name, { compression, compressedSize, size, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress one member. Only store (0) and deflate (8) occur in the FDC archives. */
export function readZipMember(buffer, entry) {
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER) {
    throw new Error('Corrupt local file header');
  }
  // The local header repeats the name and extra fields with their own lengths.
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.compression === 0) return raw;
  if (entry.compression === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.compression}`);
}

/** Read the single member whose base name matches, ignoring the archive's top directory. */
export function readZipMemberByBaseName(buffer, index, baseName) {
  for (const [name, entry] of index) {
    if (name.slice(name.lastIndexOf('/') + 1) === baseName) return readZipMember(buffer, entry);
  }
  throw new Error(`Archive has no member named ${baseName}`);
}
