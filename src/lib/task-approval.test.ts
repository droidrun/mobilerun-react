// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { formatRemaining, parsePaymentCardDetails, remainingMs } from './task-approval';

describe('parsePaymentCardDetails', () => {
  test('accepts label, package and host', () => {
    expect(parsePaymentCardDetails({ label: 'Visa 4242', targetPackage: 'com.shop', targetHost: 'shop.com' })).toEqual({
      card: 'Visa 4242',
      targetPackage: 'com.shop',
      targetHost: 'shop.com',
    });
  });
  test('falls back to credentialName and omits host', () => {
    expect(parsePaymentCardDetails({ credentialName: 'corp', targetPackage: 'com.shop' })).toEqual({
      card: 'corp',
      targetPackage: 'com.shop',
    });
  });
  test('rejects missing package, missing card name and wrong types', () => {
    expect(parsePaymentCardDetails({ label: 'x' })).toBeUndefined();
    expect(parsePaymentCardDetails({ targetPackage: 'com.shop' })).toBeUndefined();
    expect(parsePaymentCardDetails({ label: 1, targetPackage: 'a' })).toBeUndefined();
    expect(parsePaymentCardDetails({ label: 'x', targetPackage: 'a', targetHost: 3 })).toEqual({
      card: 'x',
      targetPackage: 'a',
    });
    expect(parsePaymentCardDetails(null)).toBeUndefined();
    expect(parsePaymentCardDetails('card')).toBeUndefined();
  });
});

describe('remaining time', () => {
  const at = '2026-01-01T00:10:00.000Z';
  const base = Date.parse(at);
  test('remainingMs is negative once past and tolerates bad dates', () => {
    expect(remainingMs(at, base - 5000)).toBe(5000);
    expect(remainingMs(at, base + 1)).toBe(-1);
    expect(remainingMs('nope', base)).toBe(0);
  });
  test('formatRemaining', () => {
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(61_000)).toBe('1:01');
    expect(formatRemaining(59_001)).toBe('1:00');
    expect(formatRemaining(3_725_000)).toBe('1:02:05');
    expect(formatRemaining(-5)).toBe('0:00');
  });
});
