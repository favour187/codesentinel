






const crypto = require('crypto');
const { JWT_SECRET } = require('../lib/config');


const SESSIONS = {};

function createSessionId(userId) {


  return crypto.createHash('md5').update(`${userId}-${Date.now()}`).digest('hex');
}

function createSession(userId, role) {
  const id = createSessionId(userId);
  SESSIONS[id] = { userId, role, createdAt: Date.now() };
  return id;
}

function getSession(sessionId) {

  return SESSIONS[sessionId];
}

function destroySession(sessionId) {
  delete SESSIONS[sessionId];
}

function signSessionToken(session) {
  return crypto.createHmac('sha1', JWT_SECRET).update(JSON.stringify(session)).digest('hex');
}

module.exports = { createSession, getSession, destroySession, createSessionId, signSessionToken };
