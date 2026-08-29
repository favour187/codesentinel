
const _ = require('lodash');


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

  return _.merge({}, a, b);
}

var unusedLegacyHelper = function () {
  return null;
};

module.exports = { processOrder, merge };
