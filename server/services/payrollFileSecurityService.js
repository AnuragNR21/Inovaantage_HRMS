const path = require('path');
const crypto = require('crypto');
const { PayrollDomainError } = require('../domain/payroll/payrollError');

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream'
]);

function sanitizeFilename(value) {
  const base = path.basename(String(value || 'salary-upload.xlsx'));
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'salary-upload.xlsx').slice(0, 200);
}

function containerError(message = 'The uploaded file is not a safe OOXML workbook.') {
  return new PayrollDomainError(415, 'PAYROLL_FILE_CONTAINER_INVALID', message);
}

function inspectOoxmlContainer(buffer, config) {
  const minimumOffset = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw containerError();
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directorySize = buffer.readUInt32LE(eocdOffset + 12);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (!entryCount || entryCount > 1000 || directoryOffset + directorySize > eocdOffset) throw containerError();

  const names = new Set();
  let totalUncompressed = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw containerError();
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const end = offset + 46 + filenameLength + extraLength + commentLength;
    if (end > buffer.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw containerError();
    if ((flags & 0x1) !== 0 || ![0, 8].includes(compressionMethod)) throw containerError('Encrypted or unsupported workbook entries are not accepted.');
    const name = buffer.subarray(offset + 46, offset + 46 + filenameLength).toString('utf8').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw containerError();
    names.add(name.toLowerCase());
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > (config.maxUncompressedBytes || config.maxFileBytes * 10)) {
      throw new PayrollDomainError(413, 'PAYROLL_FILE_EXPANSION_LIMIT', 'The workbook expands beyond the permitted size.');
    }
    if (uncompressedSize > 1024 * 1024 && compressedSize > 0 && uncompressedSize / compressedSize > 200) {
      throw new PayrollDomainError(413, 'PAYROLL_FILE_COMPRESSION_INVALID', 'The workbook has an unsafe compression ratio.');
    }
    offset = end;
  }
  if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml')) throw containerError();
}

function validateExcelFile({ buffer, originalFilename, mimeType, size }, config) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PayrollDomainError(400, 'PAYROLL_FILE_EMPTY', 'The uploaded file is empty.');
  }
  if (buffer.length > config.maxFileBytes || (Number(size) || 0) > config.maxFileBytes) {
    throw new PayrollDomainError(
      413,
      'PAYROLL_FILE_TOO_LARGE',
      `The Excel file must not exceed ${Math.floor(config.maxFileBytes / 1024 / 1024)} MB.`
    );
  }

  const filename = sanitizeFilename(originalFilename);
  if (path.extname(filename).toLowerCase() !== '.xlsx') {
    throw new PayrollDomainError(415, 'PAYROLL_FILE_TYPE_INVALID', 'Only .xlsx salary workbooks are accepted.');
  }

  const normalizedMime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (normalizedMime && !ALLOWED_MIME_TYPES.has(normalizedMime)) {
    throw new PayrollDomainError(415, 'PAYROLL_FILE_TYPE_INVALID', 'The uploaded file has an invalid content type.');
  }

  // OOXML workbooks are ZIP containers. The extension and client MIME are not trusted.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b ||
      !((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06))) {
    throw new PayrollDomainError(415, 'PAYROLL_FILE_SIGNATURE_INVALID', 'The uploaded file is not a valid .xlsx container.');
  }
  inspectOoxmlContainer(buffer, config);

  return Object.freeze({
    filename,
    mimeType: normalizedMime || 'application/octet-stream',
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  });
}

module.exports = { validateExcelFile, sanitizeFilename, inspectOoxmlContainer, ALLOWED_MIME_TYPES };
