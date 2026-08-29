



const { canAccess } = require('../auth/permissions');
const { getProfile } = require('../services/user-service');
const { formatAmount } = require('../services/payment-service');

function renderDashboard(container, sessionId, user, invoices) {
  if (!canAccess(sessionId, 'viewer')) {
    container.innerHTML = '<p>Access denied</p>';
    return null;
  }

  const name = getProfile(user);
  const rows = invoices
    .map((invoice) => `<tr><td>${invoice.id}</td><td>${formatAmount(invoice.amount)}</td></tr>`)
    .join('');


  container.innerHTML = `<h1>Welcome ${name}</h1><table>${rows}</table>`;
  return rows.length;
}

module.exports = { renderDashboard };
