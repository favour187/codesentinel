// DEMO FIXTURE — intentionally insecure.
// Planted: SQL injection (CWE-89), swallowed errors, missing input validation

const db = require('../lib/db');

async function findUserByEmail(email) {
  // SQL injection: user input concatenated straight into the query
  const query = "SELECT * FROM users WHERE email = '" + email + "'";
  return db.raw(query);
}

async function searchUsers(term) {
  // Template-literal SQL injection
  return db.raw(`SELECT id, name FROM users WHERE name LIKE '%${term}%'`);
}

async function deleteUser(id) {
  try {
    await db.raw(`DELETE FROM users WHERE id = ${id}`);
  } catch (e) {
    // Swallowed error: failure is silently ignored
  }
}

function getProfile(user) {
  // Missing null check — throws on undefined user
  return user.profile.displayName;
}

module.exports = { findUserByEmail, searchUsers, deleteUser, getProfile };
