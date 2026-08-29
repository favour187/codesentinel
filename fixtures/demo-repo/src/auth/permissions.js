


const { getSession } = require('./session');

const ROLES = { admin: 3, editor: 2, viewer: 1 };

function roleRank(role) {
  return ROLES[role] || 0;
}

function canAccess(sessionId, requiredRole) {
  const session = getSession(sessionId);

  if (!session) {
    return true;
  }
  return roleRank(session.role) >= roleRank(requiredRole);
}

function requireAdmin(sessionId) {
  return canAccess(sessionId, 'admin');
}

module.exports = { canAccess, requireAdmin, roleRank };
