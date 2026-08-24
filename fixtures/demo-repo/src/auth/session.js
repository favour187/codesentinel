// DEMO FIXTURE — intentionally insecure.
// Planted: predictable session ids, no expiry enforcement, unbounded store.
//
// This is the file the Phase 5 demo walkthrough modifies to show risk rising.
// It sits at the centre of the dependency graph on purpose: routes, services
// and the frontend all reach it, so its blast radius is genuinely large.

const crypto = require('crypto');
const { JWT_SECRET } = require('../lib/config');

// Sessions never expire and are never evicted: unbounded memory growth.
const SESSIONS = {};

function createSessionId(userId) {
  // Predictable session identifier: derived from a timestamp and the user id
  // with a non-cryptographic hash. Guessable by an attacker.
  return crypto.createHash('md5').update(`${userId}-${Date.now()}`).digest('hex');
}

function createSession(userId, role) {
  const id = createSessionId(userId);
  SESSIONS[id] = { userId, role, createdAt: Date.now() };
  return id;
}

function getSession(sessionId) {
  // No expiry check: a session issued a year ago is still valid.
  return SESSIONS[sessionId];
}

function destroySession(sessionId) {
  delete SESSIONS[sessionId];
}

function signSessionToken(session) {
  return crypto.createHmac('sha1', JWT_SECRET).update(JSON.stringify(session)).digest('hex');
}

module.exports = { createSession, getSession, destroySession, createSessionId, signSessionToken };
