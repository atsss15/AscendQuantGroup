import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const LIMIT = 0xffffffff; // no zip64: every size and offset must fit in 32 bits

/**
 * Write a .zip file (deflate, no zip64), streaming one entry at a time from disk to disk, so memory stays small however
 * big the files are. Each entry's header is written first and its CRC and sizes filled in once the entry is done.
 * @param {string} file   where to write the zip
 * @param {Array<{ name: string, path?: string, data?: Buffer | string }>} entries   a file on disk (path) or in memory (data)
 */
export async function writeZip(file, entries, date = new Date()) {
  if (entries.length > 0xffff) throw new Error('zip: too many files');
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const out = await fs.promises.open(file, 'w');
  let offset = 0;
  // append (or, with `at`, overwrite bytes already written)
  const put = async (buf, at) => {
    const pos = at ?? offset;
    if (at == null) offset += buf.length;
    await out.write(buf, 0, buf.length, pos);
  };
  const central = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name);
      const start = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(8, 8); // deflate
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt16LE(name.length, 26);
      await put(Buffer.concat([local, name]));

      let crc = 0;
      let size = 0;
      let packed = 0;
      const source = e.path != null ? fs.createReadStream(e.path, { highWaterMark: 1 << 18 }) : Readable.from([Buffer.from(e.data ?? '')]);
      const measure = new Transform({
        transform(chunk, enc, done) {
          crc = zlib.crc32(chunk, crc);
          size += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(source, measure, zlib.createDeflateRaw({ level: 6 }), async (chunks) => {
        for await (const chunk of chunks) {
          await put(chunk);
          packed += chunk.length;
        }
      });
      if (size > LIMIT || offset > LIMIT) throw new Error(`zip: ${e.name} is past the 4 GB limit`);

      const sizes = Buffer.alloc(12); // crc, compressed size, size: the header's bytes 14–25
      sizes.writeUInt32LE(crc, 0);
      sizes.writeUInt32LE(packed, 4);
      sizes.writeUInt32LE(size, 8);
      await put(sizes, start + 14);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4); // made by
      entry.writeUInt16LE(20, 6); // version needed
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt16LE(dosTime, 12);
      entry.writeUInt16LE(dosDate, 14);
      sizes.copy(entry, 16);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(start, 42);
      central.push(entry, name);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await put(Buffer.concat([directory, end]));
  } finally {
    await out.close();
  }
}
