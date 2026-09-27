import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUNDS_PER_MINUTE,
  buildPinInstructions,
  createCountingPuzzle,
  generatePin,
} from "../lib/challenges.ts";

const memorablePins = new Set([
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

function isMemorable(pin) {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  if ("012345678901234".includes(pin)) return true;
  if ("987654321098765".includes(pin)) return true;
  return memorablePins.has(pin);
}

function runInstructions(pin, steps) {
  let buffer = "";

  assert.ok(steps.length > 15, "the plan should contain meaningful noise");

  for (const [index, step] of steps.entries()) {
    assert.ok(
      step.action === "enter" || step.action === "delete",
      `step ${index} has a supported action`,
    );

    if (step.action === "enter") {
      assert.match(step.digit ?? "", /^\d$/, `step ${index} enters one digit`);
      assert.ok(buffer.length < 4, `step ${index} never overfills the keypad`);
      buffer += step.digit;
    } else {
      assert.equal(step.digit, undefined, `step ${index} does not delete a digit`);
      assert.ok(buffer.length > 0, `step ${index} never deletes an empty keypad`);
      buffer = buffer.slice(0, -1);
    }

    assert.equal(
      step.afterLength,
      buffer.length,
      `step ${index} accurately reports the resulting length`,
    );
    assert.ok(buffer.length <= 4, `step ${index} keeps the keypad bounded`);
    if (buffer.length === 4) {
      assert.equal(index, steps.length - 1, "the PIN is complete only at the end");
    }
  }

  assert.equal(buffer, pin, "following the plan produces the requested PIN");
}

test("challenge timing uses five grids per configured minute", () => {
  assert.equal(ROUNDS_PER_MINUTE, 5);
});

test("generated PINs are four digits and omit the deliberately memorable set", () => {
  for (let index = 0; index < 2_000; index += 1) {
    const pin = generatePin();
    assert.match(pin, /^\d{4}$/);
    assert.equal(isMemorable(pin), false, `generated ${pin} should not be memorable`);
  }
});

test("instruction plans reject anything other than an exact four-digit PIN", () => {
  for (const invalid of ["", "123", "12345", "12a4", " 1234", "1234 "]) {
    assert.throws(() => buildPinInstructions(invalid), /four-digit PIN/i);
  }
});

test("instruction plans safely converge for every possible four-digit PIN", () => {
  for (let value = 0; value <= 9_999; value += 1) {
    const pin = String(value).padStart(4, "0");
    runInstructions(pin, buildPinInstructions(pin));
  }
});

test("counting puzzles contain exactly 50 digits and a truthful answer", () => {
  for (let index = 0; index < 5_000; index += 1) {
    const puzzle = createCountingPuzzle();
    assert.ok(Number.isInteger(puzzle.target));
    assert.ok(puzzle.target >= 0 && puzzle.target <= 9);
    assert.equal(puzzle.digits.length, 50);
    assert.ok(puzzle.digits.every((digit) => Number.isInteger(digit)));
    assert.ok(puzzle.digits.every((digit) => digit >= 0 && digit <= 9));

    const actualCount = puzzle.digits.filter(
      (digit) => digit === puzzle.target,
    ).length;
    assert.equal(puzzle.answer, actualCount);
    assert.ok(puzzle.answer >= 4 && puzzle.answer <= 8);
  }
});
