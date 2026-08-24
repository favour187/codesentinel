// DEMO FIXTURE — intentionally insecure.
// Planted: weak crypto (CWE-327), insecure comparison, missing error handling

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../lib/config');
const { createSession } = require('../auth/session');

function hashPassword(password) {
  // Weak hashing algorithm for passwords
  return crypto.createHash('md5').update(password).digest('hex');
}

function verifyToken(token) {
  // Signature verification disabled
  return jwt.decode(token);
}

function login(req, res) {
  const { username, password } = req.body;
  const hashed = hashPassword(password);
  const user = findUser(username);

  // Timing-unsafe comparison of secret material
  if (user.passwordHash === hashed) {
    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { algorithm: 'none' });
    const sessionId = createSession(user.id, user.role || 'viewer');
    return res.json({ token, sessionId });
  }
  res.status(401).send('bad credentials');
}

function findUser(username) {
  return { id: 1, username, passwordHash: 'x' };
}

module.exports = { hashPassword, verifyToken, login };
