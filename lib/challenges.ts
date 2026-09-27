export type PinInstruction = {
  action: "enter" | "delete";
  digit?: string;
  afterLength: number;
};

export type CountingPuzzle = {
  target: number;
  digits: number[];
  answer: number;
};

export const ROUNDS_PER_MINUTE = 5;

function secureInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error("A positive integer range is required.");
  }
  const range = 0x1_0000_0000;
  const cutoff = range - (range % maxExclusive);
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= cutoff);
  return sample[0] % maxExclusive;
}

function randomDigit(): string {
  return String(secureInt(10));
}

function randomDigitExcept(excluded: number): number {
  const value = secureInt(9);
  return value >= excluded ? value + 1 : value;
}

function isMemorablePin(pin: string): boolean {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const ascending = "012345678901234";
  const descending = "987654321098765";
  if (ascending.includes(pin) || descending.includes(pin)) return true;
  const common = new Set([
    "0000",
    "1111",
    "1212",
    "1234",
    "2000",
    "2222",
    "2580",
    "4321",
    "5555",
    "6969",
    "7777",
    "8888",
    "9999",
  ]);
  return common.has(pin);
}

export function generatePin(): string {
  let pin = "";
  do {
    pin = Array.from({ length: 4 }, randomDigit).join("");
  } while (isMemorablePin(pin));
  return pin;
}

export function buildPinInstructions(pin: string): PinInstruction[] {
  if (!/^\d{4}$/.test(pin)) {
    throw new Error("A four-digit PIN is required.");
  }

  let buffer = "";
  const steps: PinInstruction[] = [];
  const enter = (digit: string) => {
    if (buffer.length >= 4) throw new Error("The simulated keypad is full.");
    buffer += digit;
    steps.push({ action: "enter", digit, afterLength: buffer.length });
  };
  const remove = () => {
    if (!buffer.length) return;
    buffer = buffer.slice(0, -1);
    steps.push({ action: "delete", afterLength: buffer.length });
  };
  const noiseBurst = () => {
    const room = 3 - buffer.length;
    if (room <= 0) return;
    const count = 1 + secureInt(Math.min(2, room));
    for (let index = 0; index < count; index += 1) enter(randomDigit());
    for (let index = 0; index < count; index += 1) remove();
  };

  for (let index = 0; index < 3; index += 1) {
    const bursts = 2 + secureInt(3);
    for (let burst = 0; burst < bursts; burst += 1) noiseBurst();
    enter(pin[index]);

    if (secureInt(4) !== 0) {
      remove();
      noiseBurst();
      if (secureInt(2) === 1) noiseBurst();
      enter(pin[index]);
    }
  }

  const finalScrambles = 2 + secureInt(3);
  for (let index = 0; index < finalScrambles; index += 1) {
    const retainedDigit = buffer.at(-1) ?? pin[2];
    remove();
    noiseBurst();
    enter(retainedDigit);
  }
  enter(pin[3]);

  if (buffer !== pin) {
    throw new Error("The PIN instruction plan did not converge.");
  }
  return steps;
}

function secureShuffle<T>(values: T[]): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = secureInt(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

export function createCountingPuzzle(): CountingPuzzle {
  const target = secureInt(10);
  const targetCount = 4 + secureInt(5);
  const digits = Array.from({ length: targetCount }, () => target);
  while (digits.length < 50) {
    digits.push(randomDigitExcept(target));
  }
  secureShuffle(digits);
  return { target, digits, answer: targetCount };
}
