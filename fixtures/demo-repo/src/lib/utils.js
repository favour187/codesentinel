// DEMO FIXTURE — quality issues.
const _ = require('lodash');

// Deeply nested, high-complexity function (10 levels of control flow)
function processOrder(order, user, settings, flags) {
  if (order) {
    if (order.items) {
      if (order.items.length > 0) {
        if (user) {
          if (user.active) {
            if (settings.enabled) {
              if (flags.beta) {
                for (let i = 0; i < order.items.length; i++) {
                  if (order.items[i].price > 0) {
                    if (order.items[i].stock > 0) {
                      order.items[i].total = order.items[i].price * order.items[i].quantity;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return order;
}

function merge(a, b) {
  // Prototype pollution risk via unsafe deep merge of untrusted input
  return _.merge({}, a, b);
}

var unusedLegacyHelper = function () {
  return null;
};

module.exports = { processOrder, merge };
