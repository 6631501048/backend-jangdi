const fs = require('node:fs/promises');
const path = require('node:path');
const { Job } = require('../models');
const { detectProofImage } = require('../utils/proofImage');

const proofDirectory = () => path.resolve(process.env.JOB_PROOF_DIR || path.join(__dirname, '..', '..', 'uploads', 'job-proofs'));
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

function legacyProofPath(url) {
  const match = /^\/uploads\/job-proofs\/([a-zA-Z0-9_.-]+)$/.exec(url || '');
  if (!match || match[1] === '.' || match[1] === '..') return null;
  return path.join(proofDirectory(), match[1]);
}

async function readCompletionProof(job) {
  if (job.completionProofStorage === 'mongodb') {
    // Compare the version the caller authorized/read. Never return a replacement
    // while Hirer is confirming an older version of the proof.
    const stored = await Job.findOne({ _id: job._id, completionProofUrl: job.completionProofUrl })
      .select('+completionProofData');
    if (!stored) {
      const error = new Error('รูปหลักฐานมีการเปลี่ยนแปลง กรุณาโหลดงานใหม่');
      error.statusCode = 409;
      throw error;
    }
    if (!Buffer.isBuffer(stored.completionProofData) || !stored.completionProofData.length) {
      const error = new Error('ไม่พบข้อมูลรูปหลักฐานในฐานข้อมูล กรุณาให้ผู้รับจ้างส่งรูปอีกครั้ง');
      error.statusCode = 404;
      throw error;
    }
    return stored.completionProofData;
  }

  // Existing jobs stay readable on the machine that still has their legacy file.
  const filename = legacyProofPath(job.completionProofUrl);
  if (!filename) {
    const error = new Error('ยังไม่มีหลักฐานของงานนี้');
    error.statusCode = 404;
    throw error;
  }
  try { return await fs.readFile(filename); }
  catch (error) {
    if (error.code === 'ENOENT') {
      error.message = 'รูปเดิมอยู่ใน uploads ของเครื่องที่อัปโหลด กรุณาย้ายรูปเข้าฐานข้อมูลหรือให้ผู้รับจ้างส่งรูปใหม่';
      error.statusCode = 404;
    }
    throw error;
  }
}

async function migrateLegacyProof(job, { dryRun = true } = {}) {
  if (job.completionProofStorage === 'mongodb') return 'already-shared';
  const bytes = await readCompletionProof(job);
  if (!detectProofImage(bytes) || bytes.length > MAX_PROOF_BYTES) {
    const error = new Error('ไฟล์เดิมต้องเป็น JPEG, PNG หรือ WebP ขนาดไม่เกิน 5 MB');
    error.statusCode = 400;
    throw error;
  }
  if (dryRun) return 'ready';
  const result = await Job.updateOne({
    _id: job._id,
    completionProofUrl: job.completionProofUrl,
    completionProofStorage: { $ne: 'mongodb' },
  }, { $set: { completionProofStorage: 'mongodb', completionProofData: bytes } });
  return result.modifiedCount ? 'migrated' : 'changed-or-already-shared';
}

module.exports = { readCompletionProof, migrateLegacyProof, legacyProofPath, MAX_PROOF_BYTES };
