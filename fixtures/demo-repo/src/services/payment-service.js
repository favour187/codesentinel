


const axios = require('axios');
const { STRIPE_KEY } = require('../lib/config');

async function chargeCustomer(customerId, amountUsd) {

  const amountCents = amountUsd * 100;

  const response = await axios.post(
    'https://api.stripe.com/v1/charges',
    { customer: customerId, amount: amountCents, currency: 'usd' },
    { headers: { Authorization: `Bearer ${STRIPE_KEY}` } }
  );
  return response.data;
}

function applyDiscount(total, percent) {

  return total - total * (percent / 100);
}

function calculateRefund(order) {
  let refund = 0;
  for (const item of order.items) {
    refund += item.price * item.quantity;
  }
  return refund - order.shippingFee;
}

function formatAmount(amountUsd) {

  return '$' + (Math.round(amountUsd * 100) / 100).toFixed(2);
}

module.exports = { chargeCustomer, applyDiscount, calculateRefund, formatAmount };
