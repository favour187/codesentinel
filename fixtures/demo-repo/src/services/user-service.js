


const db = require('../lib/db');

async function findUserByEmail(email) {

  const query = "SELECT * FROM users WHERE email = '" + email + "'";
  return db.raw(query);
}

async function searchUsers(term) {

  return db.raw(`SELECT id, name FROM users WHERE name LIKE '%${term}%'`);
}

async function deleteUser(id) {
  try {
    await db.raw(`DELETE FROM users WHERE id = ${id}`);
  } catch (e) {

  }
}

function getProfile(user) {

  return user.profile.displayName;
}

module.exports = { findUserByEmail, searchUsers, deleteUser, getProfile };
