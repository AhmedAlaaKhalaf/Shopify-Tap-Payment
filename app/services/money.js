const MINOR_UNITS = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

export function minorUnitsFor(currency) {
  return MINOR_UNITS[currency?.toUpperCase()] ?? 2;
}

/** Converts Shopify's decimal string ("123.45") to integer minor units without floats. */
export function toMinor(amount, currency) {
  const value = String(amount ?? "");
  if (!/^\d+(\.\d+)?$/.test(value)) throw new RangeError(`invalid amount: ${amount}`);

  const exponent = minorUnitsFor(currency);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.replace(/0+$/, "").length > exponent) {
    throw new RangeError(`amount ${amount} has more precision than ${currency} allows`);
  }

  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0").slice(0, exponent) || 0);
}
