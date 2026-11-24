const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const backend = process.env.JANGDI_FEED_DEPENDENCIES || path.resolve(__dirname, '..');
const filename = path.join(backend, 'src/controllers/job.controller.js');
const source = process.env.JANGDI_FEED_CONTROLLER || path.resolve(__dirname, '../src/controllers/job.controller.js');
const requireController = Module.createRequire(filename);
process.env.JOB_PROOF_DIR = path.join(os.tmpdir(), 'jangdi-feed-test-proofs');
const people = [{ _id: 'hirer-a', fullName: 'มาลี ใจดี' }, { _id: 'hirer-b', fullName: 'Somchai' }];
const jobs = [
  { _id: 'job-a', hirer: 'hirer-a', category: 'cleaning', title: 'ทำความสะอาด [ห้อง]', description: 'นัดเวลาล่วงหน้า', status: 'waiting', createdAt: 2 },
  { _id: 'job-b', hirer: 'hirer-b', category: 'errands', title: 'รับเอกสาร', description: 'ส่งที่มหาวิทยาลัย', status: 'waiting', createdAt: 1 },
  { _id: 'completed', hirer: 'hirer-a', title: 'งานเสร็จแล้ว', status: 'completed' },
  { _id: 'inconsistent', hirer: 'hirer-a', title: 'งานยืนยันแล้ว', status: 'waiting', completionConfirmedAt: new Date() },
];
const matches = (row, query) => Object.entries(query).every(([key, condition]) => {
  if (key === '$or') return condition.some(branch => matches(row, branch));
  if (condition === null) return row[key] == null;
  if (condition?.$regex != null) return new RegExp(condition.$regex, condition.$options).test(row[key] || '');
  if (condition?.$in) return condition.$in.includes(row[key]);
  return row[key] === condition;
});
const controller = new Module(filename, module);
controller.filename = filename;
controller.require = request => request === '../models' ? {
  User: { find: query => ({ select: async () => people.filter(person => matches(person, query)) }) },
  Job: { find: query => ({ select() { return this; }, populate() { return this; }, sort: async () => jobs.filter(job => matches(job, query)) }) },
} : requireController(request);
controller._compile(fs.readFileSync(source, 'utf8'), filename);
function feed(query = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    controller.exports.getFeed({ query }, { status(value) { status = value; return this; }, json(body) { resolve({ status, body }); } }, reject);
  });
}
test('feed includes open jobs and excludes completed or already confirmed jobs', async () => {
  assert.deepEqual((await feed()).body.map(job => job._id), ['job-a', 'job-b']);
});
test('feed supports searching by publisher name independently of title and description', async () => {
  assert.deepEqual((await feed({ search: 'มาลี' })).body.map(job => job._id), ['job-a']);
  assert.deepEqual((await feed({ search: 'somCHAI' })).body.map(job => job._id), ['job-b']);
});
test('feed punctuation is literal and cannot become an invalid or broad regular expression', async () => {
  assert.deepEqual((await feed({ search: '[' })).body.map(job => job._id), ['job-a']);
  for (const search of ['.*', '(', '$', '\\']) assert.deepEqual((await feed({ search })).body, []);
});
test('feed combines category with title, description and publisher matching', async () => {
  assert.deepEqual((await feed({ category: 'errands', search: 'เอกสาร' })).body.map(job => job._id), ['job-b']);
  assert.deepEqual((await feed({ category: 'cleaning', search: 'มาลี' })).body.map(job => job._id), ['job-a']);
  assert.deepEqual((await feed({ category: 'errands', search: 'มาลี' })).body, []);
});
test('feed rejects structured or oversized search input', async () => {
  for (const search of [{ $ne: null }, ['test'], 'x'.repeat(201)]) assert.equal((await feed({ search })).status, 400);
});
