// Run on each machine which still has legacy uploads. Files are never deleted.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { Job } = require('../src/models');
const { migrateLegacyProof } = require('../src/services/jobProof.service');

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some(flag => !['--apply', '--dry-run'].includes(flag)) || flags.includes('--apply') && flags.includes('--dry-run')) throw new Error('Usage: node scripts/migrate-job-proofs.js [--dry-run|--apply]');
  const dryRun = !flags.includes('--apply');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const totals = { ready: 0, migrated: 0, skipped: 0, missing: 0, failed: 0 };
  const jobs = Job.find({ completionProofUrl: { $type: 'string', $ne: '' }, completionProofStorage: { $ne: 'mongodb' } }).cursor();
  for await (const job of jobs) {
    try {
      const result = await migrateLegacyProof(job, { dryRun });
      if (result in totals) totals[result]++; else totals.skipped++;
      console.log(`${job._id}: ${result}`);
    } catch (error) {
      if (error.statusCode === 404) { totals.missing++; console.log(`${job._id}: file-on-another-machine-or-missing`); }
      else { totals.failed++; console.error(`${job._id}: migration failed`); }
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', ...totals }));
  if (totals.failed) process.exitCode = 1;
}

main().catch(() => { console.error('Proof migration could not complete. Check database connectivity and configuration.'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
