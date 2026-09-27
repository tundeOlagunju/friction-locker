import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  mergeVaults,
  normalizeVaultRecords,
  parseBackup,
  revealPin,
  revealSecret,
  sealPin,
  sealRecoveryCredentials,
  serializeBackup,
} from "../lib/vault.ts";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}
if (!globalThis.atob) {
  Object.defineProperty(globalThis, "atob", {
    value: (value) => Buffer.from(value, "base64").toString("binary"),
  });
}
if (!globalThis.btoa) {
  Object.defineProperty(globalThis, "btoa", {
    value: (value) => Buffer.from(value, "binary").toString("base64"),
  });
}

function makeVault(records) {
  return {
    format: "friction-vault",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    records,
  };
}

function flipFirstByte(value) {
  const bytes = Buffer.from(value, "base64");
  bytes[0] ^= 1;
  return bytes.toString("base64");
}

function clone(value) {
  return structuredClone(value);
}

test("sealing and revealing a PIN round-trips without plaintext storage", async () => {
  const pin = "0427";
  const record = await sealPin({
    pin,
    label: "  iPhone Screen Time  ",
    minutes: 10,
  });

  assert.match(
    record.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(record.label, "iPhone Screen Time");
  assert.equal(record.minutes, 10);
  assert.equal(record.kind, "screen-time-pin");
  assert.equal(Buffer.from(record.seed, "base64").length, 32);
  assert.equal(Buffer.from(record.salt, "base64").length, 16);
  assert.equal(Buffer.from(record.secretBox.iv, "base64").length, 12);
  assert.ok(Buffer.from(record.secretBox.data, "base64").length > 20);
  assert.notEqual(record.secretBox.data, Buffer.from(pin).toString("base64"));
  assert.equal(await revealPin(record), pin);
  assert.deepEqual(await revealSecret(record), {
    kind: "screen-time-pin",
    pin,
  });
});

test("sealing and revealing recovery credentials round-trips structured secrets", async () => {
  const record = await sealRecoveryCredentials({
    label: "  Screen Time Recovery  ",
    minutes: 15,
    recoveryEmail: "recovery@example.com",
    recoveryEmailPassword: "email-password-123",
    appleId: "screen-time@example.com",
    appleIdPassword: "apple-password-456",
    notes: "Created only for Screen Time recovery.",
  });

  assert.equal(record.label, "Screen Time Recovery");
  assert.equal(record.minutes, 15);
  assert.equal(record.kind, "recovery-credentials");
  assert.equal(Buffer.from(record.seed, "base64").length, 32);
  assert.equal(Buffer.from(record.salt, "base64").length, 16);
  assert.equal(Buffer.from(record.secretBox.iv, "base64").length, 12);
  assert.notEqual(
    record.secretBox.data,
    Buffer.from("screen-time@example.com").toString("base64"),
  );
  assert.deepEqual(await revealSecret(record), {
    kind: "recovery-credentials",
    recoveryEmail: "recovery@example.com",
    recoveryEmailPassword: "email-password-123",
    appleId: "screen-time@example.com",
    appleIdPassword: "apple-password-456",
    notes: "Created only for Screen Time recovery.",
  });
  await assert.rejects(() => revealPin(record), /does not contain/i);
});

test("each sealed record uses fresh key material and a fresh nonce", async () => {
  const input = { pin: "0427", label: "Screen Time", minutes: 5 };
  const first = await sealPin(input);
  const second = await sealPin(input);

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.seed, second.seed);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.secretBox.iv, second.secretBox.iv);
  assert.notEqual(first.secretBox.data, second.secretBox.data);
});

test("record creation rejects malformed PINs, labels, and durations", async () => {
  for (const pin of ["", "123", "12345", "12a4"]) {
    await assert.rejects(
      sealPin({ pin, label: "Screen Time", minutes: 10 }),
      /four-digit PIN/i,
    );
  }

  for (const label of ["", "   ", "x".repeat(121)]) {
    await assert.rejects(
      sealPin({ pin: "0427", label, minutes: 10 }),
      /label/i,
    );
  }

  for (const minutes of [0, 1.5, 61, Number.NaN]) {
    await assert.rejects(
      sealPin({ pin: "0427", label: "Screen Time", minutes }),
      /minute|duration/i,
    );
  }
});

test("recovery credential creation rejects incomplete fields", async () => {
  const valid = {
    label: "Recovery",
    minutes: 10,
    recoveryEmail: "recovery@example.com",
    recoveryEmailPassword: "email-password-123",
    appleId: "screen-time@example.com",
    appleIdPassword: "apple-password-456",
    notes: "",
  };

  for (const [field, value] of [
    ["label", ""],
    ["minutes", 0],
    ["recoveryEmail", ""],
    ["recoveryEmailPassword", ""],
    ["appleId", ""],
    ["appleIdPassword", ""],
    ["notes", "x".repeat(1_001)],
  ]) {
    await assert.rejects(
      sealRecoveryCredentials({ ...valid, [field]: value }),
      /label|minute|valid|notes/i,
      `${field} should be rejected`,
    );
  }
});

test("authenticated encryption rejects ciphertext and metadata tampering", async () => {
  const original = await sealPin({
    pin: "0427",
    label: "Screen Time",
    minutes: 10,
  });
  const alternate = await sealPin({
    pin: "3186",
    label: "Other",
    minutes: 5,
  });

  const mutations = [
    ["id", (record) => (record.id = crypto.randomUUID())],
    ["label", (record) => (record.label = "Changed label")],
    ["minutes", (record) => (record.minutes = 20)],
    ["kind", (record) => (record.kind = "changed-kind")],
    ["createdAt", (record) => (record.createdAt = "2026-02-03T00:00:00.000Z")],
    ["seed", (record) => (record.seed = alternate.seed)],
    ["salt", (record) => (record.salt = alternate.salt)],
    ["IV", (record) => (record.secretBox.iv = flipFirstByte(record.secretBox.iv))],
    [
      "ciphertext",
      (record) =>
        (record.secretBox.data = flipFirstByte(record.secretBox.data)),
    ],
  ];

  for (const [name, mutate] of mutations) {
    const changed = clone(original);
    mutate(changed);
    await assert.rejects(
      revealSecret(changed),
      /damaged|modified/i,
      `${name} tampering should be detected`,
    );
  }
});

test("backup serialization round-trips a valid vault", async () => {
  const record = await sealPin({
    pin: "0427",
    label: "Screen Time",
    minutes: 10,
  });
  const vault = makeVault([record]);
  const serialized = serializeBackup(vault);

  assert.match(serialized, /\n  "format": "friction-vault"/);
  assert.deepEqual(parseBackup(serialized), vault);
});

test("backup parsing rejects malformed envelopes and records", async (context) => {
  const record = await sealPin({
    pin: "0427",
    label: "Screen Time",
    minutes: 10,
  });
  const valid = makeVault([record]);

  assert.throws(() => parseBackup("not json"), /valid JSON/i);
  assert.throws(() => parseBackup("null"), /not a Friction Vault backup/i);

  const cases = [
    ["format", (vault) => (vault.format = "other")],
    ["version", (vault) => (vault.version = 2)],
    ["created timestamp", (vault) => (vault.createdAt = "yesterday")],
    ["updated timestamp", (vault) => (vault.updatedAt = "tomorrow")],
    [
      "timestamp order",
      (vault) => {
        vault.createdAt = "2026-01-03T00:00:00.000Z";
      },
    ],
    ["unknown envelope field", (vault) => (vault.unexpected = true)],
    ["records array", (vault) => (vault.records = {})],
    ["empty record id", (vault) => (vault.records[0].id = "")],
    ["invalid record id", (vault) => (vault.records[0].id = "record-1")],
    ["blank label", (vault) => (vault.records[0].label = "   ")],
    ["untrimmed label", (vault) => (vault.records[0].label = " Screen Time")],
    ["control character", (vault) => (vault.records[0].label = "Screen\nTime")],
    ["long label", (vault) => (vault.records[0].label = "x".repeat(121))],
    ["fractional minutes", (vault) => (vault.records[0].minutes = 1.5)],
    ["out-of-range minutes", (vault) => (vault.records[0].minutes = 61)],
    ["record kind", (vault) => (vault.records[0].kind = "password")],
    ["unknown record field", (vault) => (vault.records[0].unexpected = true)],
    ["record timestamp", (vault) => (vault.records[0].createdAt = "unknown")],
    ["seed encoding", (vault) => (vault.records[0].seed = "!!!")],
    [
      "seed length",
      (vault) => (vault.records[0].seed = Buffer.alloc(31).toString("base64")),
    ],
    [
      "salt length",
      (vault) => (vault.records[0].salt = Buffer.alloc(15).toString("base64")),
    ],
    [
      "IV length",
      (vault) =>
        (vault.records[0].secretBox.iv = Buffer.alloc(11).toString("base64")),
    ],
    [
      "ciphertext length",
      (vault) =>
        (vault.records[0].secretBox.data = Buffer.alloc(19).toString("base64")),
    ],
    [
      "unknown cipher field",
      (vault) => (vault.records[0].secretBox.unexpected = true),
    ],
    ["cipher box", (vault) => (vault.records[0].secretBox = null)],
    ["duplicate record id", (vault) => vault.records.push(clone(vault.records[0]))],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const changed = clone(valid);
      mutate(changed);
      assert.throws(
        () => parseBackup(JSON.stringify(changed)),
        /damaged|unsupported|not a Friction Vault|duplicate/i,
      );
    });
  }
});

test("normalizing keeps only the newest record per vault item type", async () => {
  const oldRecord = await sealPin({
    pin: "0427",
    label: "Old",
    minutes: 10,
  });
  const newestRecord = await sealPin({
    pin: "3186",
    label: "Newest",
    minutes: 5,
  });
  const recoveryRecord = await sealRecoveryCredentials({
    label: "Recovery",
    minutes: 15,
    recoveryEmail: "recovery@example.com",
    recoveryEmailPassword: "email-password-123",
    appleId: "screen-time@example.com",
    appleIdPassword: "apple-password-456",
    notes: "",
  });

  oldRecord.createdAt = "2026-01-01T00:00:00.000Z";
  newestRecord.createdAt = "2026-02-01T00:00:00.000Z";
  recoveryRecord.createdAt = "2026-01-15T00:00:00.000Z";

  assert.deepEqual(
    normalizeVaultRecords([oldRecord, recoveryRecord, newestRecord]).map(
      (record) => record.id,
    ),
    [newestRecord.id, recoveryRecord.id],
  );
});

test("merging backups limits the active vault to one item of each type", async () => {
  const oldRecord = await sealPin({
    pin: "0427",
    label: "Old",
    minutes: 10,
  });
  const newestRecord = await sealPin({
    pin: "3186",
    label: "Newest",
    minutes: 5,
  });
  const recoveryRecord = await sealRecoveryCredentials({
    label: "Recovery",
    minutes: 15,
    recoveryEmail: "recovery@example.com",
    recoveryEmailPassword: "email-password-123",
    appleId: "screen-time@example.com",
    appleIdPassword: "apple-password-456",
    notes: "",
  });

  oldRecord.createdAt = "2026-01-01T00:00:00.000Z";
  newestRecord.createdAt = "2026-02-01T00:00:00.000Z";
  recoveryRecord.createdAt = "2026-01-15T00:00:00.000Z";

  const current = makeVault([oldRecord]);
  const incoming = makeVault([newestRecord, recoveryRecord]);
  const merged = mergeVaults(current, incoming);

  assert.equal(merged.format, current.format);
  assert.equal(merged.version, current.version);
  assert.equal(merged.createdAt, current.createdAt);
  assert.equal(merged.records.length, 2);
  assert.deepEqual(
    merged.records.map((record) => record.id),
    [newestRecord.id, recoveryRecord.id],
  );
});
