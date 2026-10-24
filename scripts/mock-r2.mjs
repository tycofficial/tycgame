import { createHash, randomUUID } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function bytesOf(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  if (typeof value.getReader === 'function') {
    const chunks = [];
    let size = 0;
    for await (const chunk of value) {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk);
      chunks.push(bytes);
      size += bytes.byteLength;
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }
  throw new TypeError('Unsupported mock R2 body');
}

function tag(bytes) { return createHash('md5').update(bytes).digest('hex'); }
function unquote(value) { return String(value ?? '').replace(/^W\//, '').replace(/^"|"$/g, ''); }
function clone(value) { return value == null ? value : structuredClone(value); }

function conditionalMatches(record, onlyIf) {
  if (!onlyIf) return true;
  const get = name => onlyIf instanceof Headers ? onlyIf.get(name) : undefined;
  const etagMatches = onlyIf.etagMatches ?? get('if-match');
  const etagDoesNotMatch = onlyIf.etagDoesNotMatch ?? get('if-none-match');
  if (etagMatches != null && (!record || (etagMatches !== '*' && unquote(etagMatches) !== record.etag))) return false;
  if (etagDoesNotMatch != null && record && (etagDoesNotMatch === '*' || unquote(etagDoesNotMatch) === record.etag)) return false;
  return true;
}

export class MockR2Bucket {
  constructor() {
    this.objects = new Map();
    this.uploads = new Map();
    this.stats = { getCalls: 0, putCalls: 0, fullBodyReads: 0, fullBodyReadKeys: [], streamBytesServed: 0, rangeGets: [] };
  }

  makeRecord(key, bytes, options = {}) {
    return {
      key, bytes, size: options.virtualSize ?? bytes.byteLength,
      virtual: options.virtualSize != null, prefix: bytes,
      etag: options.etag ?? tag(bytes), version: randomUUID(), uploaded: new Date(),
      httpMetadata: clone(options.httpMetadata ?? {}), customMetadata: clone(options.customMetadata ?? {}),
    };
  }

  describe(record) {
    if (!record) return null;
    return {
      key: record.key, version: record.version, size: record.size, etag: record.etag,
      httpEtag: `"${record.etag}"`, uploaded: record.uploaded,
      httpMetadata: clone(record.httpMetadata), customMetadata: clone(record.customMetadata),
      checksums: {},
      writeHttpMetadata(headers) {
        const names = { contentType: 'Content-Type', contentLanguage: 'Content-Language', contentDisposition: 'Content-Disposition', contentEncoding: 'Content-Encoding', cacheControl: 'Cache-Control', cacheExpiry: 'Expires' };
        for (const [key, value] of Object.entries(record.httpMetadata)) {
          if (value != null && names[key]) headers.set(names[key], value instanceof Date ? value.toUTCString() : value);
        }
      },
    };
  }

  async put(key, value, options = {}) {
    this.stats.putCalls++;
    const bytes = await bytesOf(value);
    if (!conditionalMatches(this.objects.get(key), options.onlyIf)) return null;
    const record = this.makeRecord(key, bytes, options);
    this.objects.set(key, record);
    return this.describe(record);
  }

  seedVirtual(key, size, options = {}) {
    const bytes = encoder.encode(options.prefix ?? '<!doctype html><title>Large application</title>');
    const record = this.makeRecord(key, bytes, { ...options, virtualSize: size });
    this.objects.set(key, record);
    return this.describe(record);
  }

  async head(key) { return this.describe(this.objects.get(key)); }

  async get(key, options = {}) {
    this.stats.getCalls++;
    const record = this.objects.get(key);
    if (!record) return null;
    const description = this.describe(record);
    if (!conditionalMatches(record, options.onlyIf)) return description;
    let offset = 0;
    let length = record.size;
    if (options.range) {
      const range = options.range;
      if (range instanceof Headers) throw new Error('Range Headers are not implemented by this mock');
      if (range.suffix != null) { length = Math.min(record.size, range.suffix); offset = record.size - length; }
      else { offset = range.offset ?? 0; length = Math.min(record.size - offset, range.length ?? record.size); }
      if (offset < 0 || length < 0 || offset >= record.size) throw new Error('Invalid mock R2 range');
      description.range = { offset, length };
      this.stats.rangeGets.push({ key, offset, length });
    }
    const bucket = this;
    let position = offset;
    const end = offset + length;
    const body = new ReadableStream({
      pull(controller) {
        if (position >= end) { controller.close(); return; }
        const next = Math.min(end, position + 64 * 1024);
        let chunk;
        if (record.virtual) {
          chunk = new Uint8Array(next - position);
          const available = record.prefix.subarray(position, Math.min(next, record.prefix.length));
          chunk.set(available);
        } else chunk = record.bytes.slice(position, next);
        bucket.stats.streamBytesServed += chunk.byteLength;
        position = next;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    const response = new Response(body);
    return {
      ...description, body,
      get bodyUsed() { return response.bodyUsed; },
      async text() { bucket.stats.fullBodyReads++; bucket.stats.fullBodyReadKeys.push(key); return response.text(); },
      async arrayBuffer() { bucket.stats.fullBodyReads++; bucket.stats.fullBodyReadKeys.push(key); return response.arrayBuffer(); },
      async json() { bucket.stats.fullBodyReads++; bucket.stats.fullBodyReadKeys.push(key); return JSON.parse(await response.text()); },
      async blob() { bucket.stats.fullBodyReads++; bucket.stats.fullBodyReadKeys.push(key); return response.blob(); },
    };
  }

  async list(options = {}) {
    const prefix = options.prefix ?? '';
    const all = [...this.objects.values()].filter(x => x.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const objects = [];
    const delimitedPrefixes = new Set();
    const selected = all.slice(start, start + limit);
    for (const record of selected) {
      const rest = record.key.slice(prefix.length);
      if (options.delimiter && rest.includes(options.delimiter)) {
        delimitedPrefixes.add(prefix + rest.slice(0, rest.indexOf(options.delimiter) + options.delimiter.length));
      } else objects.push(this.describe(record));
    }
    const truncated = start + limit < all.length;
    return { objects, truncated, cursor: truncated ? String(start + limit) : undefined, delimitedPrefixes: [...delimitedPrefixes] };
  }

  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }

  async createMultipartUpload(key, options = {}) {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, options: clone(options), parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key, uploadId) {
    const bucket = this;
    const ensure = () => {
      const upload = bucket.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('Multipart upload does not exist');
      return upload;
    };
    return {
      key, uploadId,
      async uploadPart(partNumber, value) {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error('Invalid multipart part number');
        const bytes = await bytesOf(value);
        const etag = tag(bytes);
        ensure().parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      async complete(parts) {
        const upload = ensure();
        if (!parts.length) throw new Error('Multipart upload has no parts');
        let size = 0;
        let previous = 0;
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          const stored = upload.parts.get(part.partNumber);
          if (part.partNumber <= previous || !stored || stored.etag !== part.etag) throw new Error('Invalid multipart completion');
          if (index < parts.length - 1 && stored.bytes.byteLength < 5 * 1024 ** 2) throw new Error('Multipart parts must be at least 5 MiB');
          previous = part.partNumber;
          size += stored.bytes.byteLength;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { const stored = upload.parts.get(part.partNumber); bytes.set(stored.bytes, offset); offset += stored.bytes.byteLength; }
        const result = await bucket.put(key, bytes, upload.options);
        bucket.uploads.delete(uploadId);
        return result;
      },
      async abort() { bucket.uploads.delete(uploadId); },
    };
  }

  textAt(key) {
    const record = this.objects.get(key);
    return record && decoder.decode(record.bytes);
  }
}
