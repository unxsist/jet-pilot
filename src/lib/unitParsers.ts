const memoryMultipliers: { [key: string]: number } = {
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

export function memoryParser(input: string) {
  const unitMatch = input.match(/^([0-9]+)([A-Za-z]{1,2})$/);
  if (unitMatch) {
    return parseInt(unitMatch[1], 10) * memoryMultipliers[unitMatch[2]];
  }

  return parseInt(input, 10);
}
