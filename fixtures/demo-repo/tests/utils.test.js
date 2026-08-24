// The ONLY test file in this fixture — payment-service.js has no coverage.
const { describe, it, expect } = require('vitest');
const { processOrder } = require('../src/lib/utils');

describe('processOrder', () => {
  it('returns the order unchanged when input is empty', () => {
    expect(processOrder(null, null, {}, {})).toBe(null);
  });
});
