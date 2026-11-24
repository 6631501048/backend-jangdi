const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let stored, updates;
const Job = {
  findOne: query => ({ select: async () => stored && stored._id === query._id && stored.completionProofUrl === query.completionProofUrl ? stored : null }),
  updateOne: async (query,change) => {
    if (stored._id !== query._id || stored.completionProofUrl !== query.completionProofUrl || stored.completionProofStorage === 'mongodb') return {modifiedCount:0};
    Object.assign(stored,change.$set);updates++;return {modifiedCount:1};
  },
};
const filename = require.resolve('../src/models');
require.cache[filename] = {id:filename,filename,loaded:true,exports:{Job}};
const {readCompletionProof,migrateLegacyProof,legacyProofPath} = require('../src/services/jobProof.service');
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
test('database proof reads use the exact authorized version; replaced versions are rejected',async()=>{
  stored={_id:'job1',completionProofUrl:'/uploads/job-proofs/v2.png',completionProofStorage:'mongodb',completionProofData:png};
  assert.deepEqual(await readCompletionProof(stored),png);
  await assert.rejects(readCompletionProof({...stored,completionProofUrl:'/uploads/job-proofs/v1.png'}),err=>err.statusCode===409);
});
test('legacy path parsing never follows arbitrary input',()=>{
  for (const url of ['/uploads/job-proofs/../secret','/uploads/job-proofs/..','https://example.com/photo.jpg','/uploads/other/photo.jpg']) assert.equal(legacyProofPath(url),null);
});
test('migration is dry-run by default, copies bytes atomically, and preserves original file',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jangdi-proof-'));
  const before=process.env.JOB_PROOF_DIR;process.env.JOB_PROOF_DIR=directory;
  stored={_id:'legacy1',completionProofUrl:'/uploads/job-proofs/legacy.png'};updates=0;
  await fs.writeFile(path.join(directory,'legacy.png'),png);
  try {
    assert.equal(await migrateLegacyProof(stored),'ready');assert.equal(updates,0);
    assert.equal(await migrateLegacyProof(stored,{dryRun:false}),'migrated');assert.equal(updates,1);
    assert.deepEqual(stored.completionProofData,png);assert.deepEqual(await fs.readFile(path.join(directory,'legacy.png')),png);
    assert.equal(await migrateLegacyProof(stored,{dryRun:false}),'already-shared');assert.equal(updates,1);
  } finally {
    if (before===undefined) delete process.env.JOB_PROOF_DIR;else process.env.JOB_PROOF_DIR=before;
    await fs.rm(directory,{recursive:true,force:true});
  }
});
test('ordinary job JSON omits binary evidence even after explicit selection',()=>{
  const Model=require('../src/models/Job');
  const job=new Model({completionProofStorage:'mongodb',completionProofData:png});
  assert.equal(Model.schema.path('completionProofData').options.select,false);
  assert.equal(job.toJSON().completionProofData,undefined);
});
