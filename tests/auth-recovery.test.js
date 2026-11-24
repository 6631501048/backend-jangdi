const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = Module;
const dependencyRoot = process.env.JANGDI_AUTH_DEPENDENCIES || path.resolve(__dirname, '..');
const dependency = createRequire(path.join(dependencyRoot, 'package.json'));
const bcrypt = dependency('bcryptjs');
const jwt = dependency('jsonwebtoken');
const express = dependency('express');
const { hashResetToken } = require('../src/utils/passwordRecovery');
let users, mails, googlePayload, mailConfigured, deliveryWorks, nowId;
const copy = value => structuredClone(value);
function doc(value) {
  if (!value) return null;
  const data = copy(value);
  Object.defineProperties(data, {
    toObject: { value: () => copy(Object.fromEntries(Object.entries(data))) },
    save: { value: async () => { users.set(data._id, copy(Object.fromEntries(Object.entries(data)))); return data; } },
  });
  return data;
}
function matches(user, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(entry => matches(user, entry));
    if (value === null) return user[key] == null;
    if (value && typeof value === 'object') {
      if ('$ne' in value) return user[key] !== value.$ne;
      if ('$lte' in value) return user[key] != null && user[key] <= value.$lte;
      if ('$gt' in value) return user[key] != null && user[key] > value.$gt;
    }
    return user[key] === value;
  });
}
const queryResult = value => ({ select: () => Promise.resolve(doc(value)), then: (resolve, reject) => Promise.resolve(doc(value)).then(resolve, reject) });
const User = {
  findOne: query => queryResult([...users.values()].find(user => matches(user, query))),
  findById: id => queryResult(users.get(id)),
  create: async value => { const user = { _id: `user-${++nowId}`, authVersion: 0, accountStatus: 'active', ...value }; users.set(user._id, user); return doc(user); },
  findOneAndUpdate: async (query, update) => {
    const user = [...users.values()].find(user => matches(user, query));
    if (!user) return null;
    Object.assign(user, copy(update.$set || {}));
    for (const [key, value] of Object.entries(update.$inc || {})) user[key] = (user[key] || 0) + value;
    return doc(user);
  },
  updateOne: async (query, update) => User.findOneAndUpdate(query, update),
};
const previousLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === '../models' && /auth\.(controller|middleware)\.js$/.test(parent?.filename || '')) return { User };
  if (request === '../utils/mailer' && /auth.controller.js$/.test(parent?.filename || '')) return {
    isEmailConfigured: () => mailConfigured,
    sendEmail: async mail => { mails.push(mail); return { sent: deliveryWorks }; },
  };
  if (request === '../middleware/rateLimit.middleware') return previousLoad.call(this, path.join(dependencyRoot, 'src/middleware/rateLimit.middleware.js'), parent, ...rest);
  if (request === 'google-auth-library') return { OAuth2Client: class { async verifyIdToken({ idToken }) { if (idToken === 'invalid') throw new Error('Expired'); return { getPayload: () => googlePayload }; } } };
  if (['express', 'bcryptjs', 'jsonwebtoken', 'express-async-handler'].includes(request)) return previousLoad.call(this, dependency.resolve(request), parent, ...rest);
  return previousLoad.call(this, request, parent, ...rest);
};
let router;
try { router = require('../src/routes/auth.routes'); }
finally { Module._load = previousLoad; }
let server, base;
test.before(async () => {
  process.env.JWT_SECRET = 'isolated-auth-fixture-secret-at-least-32-characters';
  process.env.CLIENT_URL = 'http://localhost:5173';
  const app = express(); app.use(express.json());
  app.use('/auth', router);
  app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));
test.beforeEach(() => {
  process.env.NODE_ENV = 'test'; process.env.DISABLE_RATE_LIMIT = 'true';
  users = new Map(); mails = []; nowId = 0; mailConfigured = true; deliveryWorks = true;
  googlePayload = { email: 'student@lamduan.mfu.ac.th', email_verified: true, sub: 'google-student', name: 'Student' };
});
async function request(route, body, token, method = 'POST') {
  const response = await fetch(`${base}/auth/${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function seed(password = 'original-password') {
  return User.create({ email: googlePayload.email, studentId: 'student', password: password ? await bcrypt.hash(password, 10) : undefined, isEmailVerified: true, isProfileComplete: true, currentRole: 'worker' });
}
function emailedToken() {
  const link = mails.at(-1).html.match(/href="([^"]+)"/)[1];
  const url = new URL(link);
  assert.equal(url.pathname, '/reset-password'); assert.equal(url.search, '');
  return new URLSearchParams(url.hash.slice(1)).get('token');
}

test('real bcrypt password login succeeds; wrong, absent and malformed credentials return 401', async () => {
  const user = await seed();
  const login = await request('login', { email: ' STUDENT@LAMDUAN.MFU.AC.TH ', password: 'original-password' });
  assert.equal(login.status, 200); assert.equal(login.body.user._id, user._id);
  assert.equal(jwt.verify(login.body.token, process.env.JWT_SECRET).id, user._id);
  assert(!('password' in login.body.user));
  for (const body of [{ email: user.email, password: 'wrong' }, { email: user.email }, { email: { $ne: null }, password: [] }, {}]) assert.equal((await request('login', body)).status, 401);
});

test('password account and verified Google email share one user and both login methods keep working', async () => {
  const user = await seed(); users.get(user._id).isEmailVerified = false;
  const result = await request('google', { idToken: 'verified-test-token' });
  assert.equal(result.status, 200); assert.equal(result.body.user._id, user._id); assert.equal(users.size, 1);
  assert.equal(result.body.user.isEmailVerified, true);
  assert.equal(users.get(user._id).googleId, googlePayload.sub);
  assert.equal((await request('login', { email: user.email, password: 'original-password' })).status, 200);
});

test('Google-only account gains a password through email recovery without a duplicate account', async () => {
  const google = await request('google', { idToken: 'verified-test-token' });
  const id = google.body.user._id;
  assert.equal((await request('login', { email: googlePayload.email, password: 'anything' })).status, 401);
  const result = await request('forgot-password', { email: googlePayload.email });
  assert.equal(result.status, 200);
  const token = emailedToken();
  assert.equal(users.get(id).passwordResetToken, hashResetToken(token));
  const issued = users.get(id).passwordResetRequestedAt.getTime();
  assert.equal(users.get(id).passwordResetExpires.getTime() - issued, 15 * 60_000);
  assert(mails.at(-1).html.includes('15 นาที'));
  assert(!JSON.stringify(result.body).includes(token));
  const reset = await request('reset-password', { token, password: 'new-account-password' });
  assert.equal(reset.status, 200); assert.equal(users.size, 1);
  assert.notEqual(users.get(id).password, 'new-account-password');
  const login = await request('login', { email: googlePayload.email, password: 'new-account-password' });
  assert.equal(login.body.user._id, id);
  assert.equal((await request('google', { idToken: 'verified-test-token' })).body.user._id, id);
  assert.equal((await request('me', null, google.body.token, 'GET')).status, 401);
  assert.equal((await request('me', null, login.body.token, 'GET')).status, 200);
  for (const key of ['password', 'passwordResetToken', 'passwordResetExpires', 'passwordResetRequestedAt', 'authVersion']) assert(!Object.hasOwn(login.body.user, key));
});

test('unknown, suspended and cooldown emails get identical generic responses and cannot spam mail', async () => {
  const user = await seed();
  const first = await request('forgot-password', { email: user.email });
  const again = await request('forgot-password', { email: user.email });
  const unknown = await request('forgot-password', { email: 'unknown@lamduan.mfu.ac.th' });
  users.get(user._id).accountStatus = 'suspended';
  const suspended = await request('forgot-password', { email: user.email });
  assert.deepEqual(first, again); assert.deepEqual(first, unknown); assert.deepEqual(first, suspended); assert.equal(mails.length, 1);
});

test('a replacement link invalidates the earlier link; only one concurrent reset succeeds', async () => {
  const user = await seed();
  await request('forgot-password', { email: user.email }); const older = emailedToken();
  users.get(user._id).passwordResetRequestedAt = new Date(Date.now() - 61_000);
  await request('forgot-password', { email: user.email }); const token = emailedToken();
  assert.notEqual(token, older);
  assert.equal((await request('reset-password', { token: older, password: 'replacement-password' })).body.code, 'RESET_LINK_INVALID');
  const results = await Promise.all([request('reset-password', { token, password: 'first-password' }), request('reset-password', { token, password: 'second-password' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(users.get(user._id).authVersion, 1);
  assert.equal((await request('reset-password', { token, password: 'reused-password' })).status, 400);
});

test('expired, malformed, weak and oversized passwords do not change the account', async () => {
  const user = await seed(); await request('forgot-password', { email: user.email }); const token = emailedToken();
  for (const password of ['short', 'ก'.repeat(25), { $ne: null }]) assert.equal((await request('reset-password', { token, password })).status, 400);
  users.get(user._id).passwordResetExpires = new Date(Date.now() - 1000);
  for (const invalidToken of [token, 'missing', { $ne: null }]) assert.equal((await request('reset-password', { token: invalidToken, password: 'valid-password' })).body.code, 'RESET_LINK_INVALID');
  assert(await bcrypt.compare('original-password', users.get(user._id).password));
});

test('reset invalidates existing and legacy JWTs, old password and verification secrets', async () => {
  const user = await seed(); users.get(user._id).isEmailVerified = false; users.get(user._id).emailVerificationToken = 'verification-secret';
  const legacy = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  assert.equal((await request('me', null, legacy, 'GET')).status, 200);
  await request('forgot-password', { email: user.email });
  assert.equal((await request('reset-password', { token: emailedToken(), password: 'reset-password-123' })).status, 200);
  assert.equal((await request('me', null, legacy, 'GET')).status, 401);
  assert.equal((await request('login', { email: user.email, password: 'original-password' })).status, 401);
  assert.equal(users.get(user._id).emailVerificationToken, null); assert.equal(users.get(user._id).isEmailVerified, true);
});

test('suspended accounts cannot reset passwords or use either login method', async () => {
  const user = await seed(); await request('forgot-password', { email: user.email }); const token = emailedToken();
  users.get(user._id).accountStatus = 'suspended';
  assert.equal((await request('reset-password', { token, password: 'new-password' })).status, 400);
  assert.equal((await request('login', { email: user.email, password: 'original-password' })).status, 403);
  assert.equal((await request('google', { idToken: 'verified-test-token' })).status, 403);
});

test('missing SMTP is explicit for every address; failed delivery clears unusable reset secrets', async () => {
  const user = await seed(); mailConfigured = false;
  for (const email of [user.email, 'unknown@lamduan.mfu.ac.th']) assert.equal((await request('forgot-password', { email })).status, 503);
  assert.equal(mails.length, 0);
  mailConfigured = true; deliveryWorks = false;
  assert.equal((await request('forgot-password', { email: user.email })).status, 200);
  assert.equal(users.get(user._id).passwordResetToken, null);
  assert(await bcrypt.compare('original-password', users.get(user._id).password));
});

test('Google rejects invalid tokens, unverified email and mismatched linked Google identity', async () => {
  assert.equal((await request('google', { idToken: 'invalid' })).status, 401);
  googlePayload.email_verified = false;
  assert.equal((await request('google', { idToken: 'valid' })).status, 403);
  assert.equal(users.size, 0);
  googlePayload.email_verified = true; googlePayload.email = 'student@lamduan.mfuXacYth';
  assert.equal((await request('google', { idToken: 'valid' })).status, 403);
  googlePayload.email = 'student@lamduan.mfu.ac.th';
  googlePayload.email_verified = true;
  const user = await seed(); users.get(user._id).googleId = 'different-google-sub';
  assert.equal((await request('google', { idToken: 'valid' })).status, 409);
});

test('changing a password preserves the caller with a new JWT and invalidates an outstanding recovery link', async () => {
  const user = await seed();
  const login = await request('login', { email: user.email, password: 'original-password' });
  await request('forgot-password', { email: user.email }); const token = emailedToken();
  const wrong = await request('password', { current: 'wrong', next: 'valid-password' }, login.body.token, 'PATCH');
  assert.equal(wrong.status, 401);
  assert.equal((await request('me', null, login.body.token, 'GET')).status, 200);
  const change = await request('password', { current: 'original-password', next: 'updated-password' }, login.body.token, 'PATCH');
  assert.equal(change.status, 200);
  assert.equal((await request('me', null, change.body.token, 'GET')).status, 200);
  assert.equal((await request('me', null, login.body.token, 'GET')).status, 401);
  assert.equal((await request('reset-password', { token, password: 'link-password' })).status, 400);
});

test('recovery and reset endpoints enforce IP rate limits', async () => {
  process.env.DISABLE_RATE_LIMIT = 'false';
  for (let index = 0; index < 5; index++) assert.equal((await request('forgot-password', { email: 'unknown@lamduan.mfu.ac.th' })).status, 200);
  assert.equal((await request('forgot-password', { email: 'unknown@lamduan.mfu.ac.th' })).status, 429);
  for (let index = 0; index < 10; index++) assert.equal((await request('reset-password', { token: 'bad', password: 'valid-password' })).status, 400);
  assert.equal((await request('reset-password', { token: 'bad', password: 'valid-password' })).status, 429);
});
