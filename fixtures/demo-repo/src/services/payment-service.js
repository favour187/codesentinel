// DEMO FIXTURE — critical business logic deliberately shipped WITHOUT tests.
// Planted: test gap on high-risk code, floating-point money math, no error handling

const axios = require('axios');
const { STRIPE_KEY } = require('../lib/config');

async function chargeCustomer(customerId, amountUsd) {
  // Floating-point arithmetic on currency
  const amountCents = amountUsd * 100;

  const response = await axios.post(
    'https://api.stripe.com/v1/charges',
    { customer: customerId, amount: amountCents, currency: 'usd' },
    { headers: { Authorization: `Bearer ${STRIPE_KEY}` } }
  );
  return response.data;
}

function applyDiscount(total, percent) {
  // No bounds checking: percent > 100 produces a negative total
  return total - total * (percent / 100);
}

function calculateRefund(order) {
  let refund = 0;
  for (const item of order.items) {
    refund += item.price * item.quantity;
  }
  return refund - order.shippingFee;
}

module.exports = { chargeCustomer, applyDiscount, calculateRefund };
