export type CipherBox = {
  iv: string;
  data: string;
};

export type VaultRecord = {
  id: string;
  label: string;
  minutes: number;
  kind: "screen-time-pin" | "recovery-credentials";
  createdAt: string;
  seed: string;
  salt: string;
  secretBox: CipherBox;
};

export type ScreenTimePinSecret = {
  kind: "screen-time-pin";
  pin: string;
};

export type RecoveryCredentialsSecret = {
  kind: "recovery-credentials";
  recoveryEmail: string;
  recoveryEmailPassword: string;
  appleId: string;
  appleIdPassword: string;
  notes: string;
};

export type VaultSecret = ScreenTimePinSecret | RecoveryCredentialsSecret;

export type VaultFile = {
  format: "friction-vault";
  version: 1;
  createdAt: string;
  updatedAt: string;
  records: VaultRecord[];
};

const DATABASE_NAME = "friction-vault";
const DATABASE_VERSION = 1;
const STORE_NAME = "vault";
const PRIMARY_KEY = "primary";
const KEY_INFO = "friction-vault-record-key:v1";
const MAX_BACKUP_BYTES = 2_000_000;
const MAX_RECORDS = 1_000;
const MAX_CIPHERTEXT_BYTES = 8_192;

const VAULT_KEYS = [
  "format",
  "version",
  "createdAt",
  "updatedAt",
  "records",
] as const;
const RECORD_KEYS = [
  "id",
  "label",
  "minutes",
  "kind",
  "createdAt",
  "seed",
  "salt",
  "secretBox",
] as const;
const CIPHER_BOX_KEYS = ["iv", "data"] as const;
const RECORD_KINDS = ["screen-time-pin", "recovery-credentials"] as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure encryption is not available in this browser.");
  }
  return globalThis.crypto;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function metadataFor(
  record: Omit<VaultRecord, "secretBox">,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      id: record.id,
      label: record.label,
      minutes: record.minutes,
      kind: record.kind,
      createdAt: record.createdAt,
      seed: record.seed,
      salt: record.salt,
    }),
  );
}

async function deriveRecordKey(seed: string, salt: string): Promise<CryptoKey> {
  const material = await getCrypto().subtle.importKey(
    "raw",
    base64ToBytes(seed),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return getCrypto().subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64ToBytes(salt),
      info: new TextEncoder().encode(KEY_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptSecret(
  secret: string,
  record: Omit<VaultRecord, "secretBox">,
): Promise<CipherBox> {
  const key = await deriveRecordKey(record.seed, record.salt);
  const iv = randomBytes(12);
  const encrypted = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: metadataFor(record),
    },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Local vault storage is unavailable in this browser."));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onerror = () =>
      rejectOnce(
        request.error ?? new Error("Could not open the local vault."),
      );
    request.onblocked = () =>
      rejectOnce(
        new Error(
          "The local vault is open in another tab. Close it there and try again.",
        ),
      );
  });
}

async function databaseOperation<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let settled = false;
    let requestFinished = false;
    let requestResult: T;
    let operationError: DOMException | null = null;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(error);
    };

    try {
      const transaction = database.transaction(STORE_NAME, mode);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        database.close();
        if (!requestFinished) {
          reject(new Error("Local vault storage did not finish correctly."));
          return;
        }
        resolve(requestResult);
      };
      transaction.onerror = () => {
        operationError ??= transaction.error;
      };
      transaction.onabort = () =>
        rejectOnce(
          operationError ??
            transaction.error ??
            new Error("Local vault storage was interrupted."),
        );

      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => {
        requestResult = request.result;
        requestFinished = true;
      };
      request.onerror = () => {
        operationError = request.error;
      };
    } catch (cause) {
      rejectOnce(
        cause instanceof Error
          ? cause
          : new Error("Local vault storage failed."),
      );
    }
  });
}

function emptyVault(): VaultFile {
  const now = new Date().toISOString();
  return {
    format: "friction-vault",
    version: 1,
    createdAt: now,
    updatedAt: now,
    records: [],
  };
}

export async function loadVault(): Promise<VaultFile> {
  const existing = await databaseOperation<VaultFile | undefined>(
    "readonly",
    (store) => store.get(PRIMARY_KEY),
  );
  if (existing) return existing;

  const vault = emptyVault();
  await saveVault(vault);
  return vault;
}

export async function saveVault(vault: VaultFile): Promise<VaultFile> {
  const updated = {
    ...vault,
    records: normalizeVaultRecords(vault.records),
    updatedAt: new Date().toISOString(),
  };
  await databaseOperation<IDBValidKey>("readwrite", (store) =>
    store.put(updated, PRIMARY_KEY),
  );
  return updated;
}

export async function sealPin(input: {
  pin: string;
  label: string;
  minutes: number;
}): Promise<VaultRecord> {
  if (!/^\d{4}$/.test(input.pin)) {
    throw new Error("A four-digit PIN is required.");
  }
  const label = input.label.trim();
  if (!isValidLabel(label)) {
    throw new Error("Use a label between 1 and 120 characters.");
  }
  if (!isValidMinutes(input.minutes)) {
    throw new Error("Choose a retrieval time between 1 and 60 minutes.");
  }
  const recordWithoutBox: Omit<VaultRecord, "secretBox"> = {
    id: getCrypto().randomUUID(),
    label,
    minutes: input.minutes,
    kind: "screen-time-pin",
    createdAt: new Date().toISOString(),
    seed: bytesToBase64(randomBytes(32)),
    salt: bytesToBase64(randomBytes(16)),
  };
  return {
    ...recordWithoutBox,
    secretBox: await encryptSecret(
      JSON.stringify({ kind: "screen-time-pin", pin: input.pin }),
      recordWithoutBox,
    ),
  };
}

export async function sealRecoveryCredentials(input: {
  label: string;
  minutes: number;
  recoveryEmail: string;
  recoveryEmailPassword: string;
  appleId: string;
  appleIdPassword: string;
  notes?: string;
}): Promise<VaultRecord> {
  const label = input.label.trim();
  const recoveryEmail = input.recoveryEmail.trim();
  const appleId = input.appleId.trim();
  const recoveryEmailPassword = input.recoveryEmailPassword.trim();
  const appleIdPassword = input.appleIdPassword.trim();
  const notes = (input.notes ?? "").trim();

  if (!isValidLabel(label)) {
    throw new Error("Use a label between 1 and 120 characters.");
  }
  if (!isValidMinutes(input.minutes)) {
    throw new Error("Choose a retrieval time between 1 and 60 minutes.");
  }
  for (const [field, value] of [
    ["recovery email", recoveryEmail],
    ["recovery email password", recoveryEmailPassword],
    ["Apple ID", appleId],
    ["Apple ID password", appleIdPassword],
  ] as const) {
    if (!isValidSecretText(value, 320)) {
      throw new Error(`Enter a valid ${field}.`);
    }
  }
  if (notes && !isValidSecretText(notes, 1_000)) {
    throw new Error("Keep notes under 1,000 characters.");
  }

  const recordWithoutBox: Omit<VaultRecord, "secretBox"> = {
    id: getCrypto().randomUUID(),
    label,
    minutes: input.minutes,
    kind: "recovery-credentials",
    createdAt: new Date().toISOString(),
    seed: bytesToBase64(randomBytes(32)),
    salt: bytesToBase64(randomBytes(16)),
  };

  const secret: RecoveryCredentialsSecret = {
    kind: "recovery-credentials",
    recoveryEmail,
    recoveryEmailPassword,
    appleId,
    appleIdPassword,
    notes,
  };

  return {
    ...recordWithoutBox,
    secretBox: await encryptSecret(JSON.stringify(secret), recordWithoutBox),
  };
}

export async function revealSecret(record: VaultRecord): Promise<VaultSecret> {
  try {
    const { secretBox, ...metadata } = record;
    const key = await deriveRecordKey(record.seed, record.salt);
    const decrypted = await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(secretBox.iv),
        additionalData: metadataFor(metadata),
      },
      key,
      base64ToBytes(secretBox.data),
    );
    const plaintext = new TextDecoder().decode(decrypted);
    return parseSecretPayload(plaintext, record.kind);
  } catch {
    throw new Error("This record is damaged or has been modified.");
  }
}

export async function revealPin(record: VaultRecord): Promise<string> {
  const secret = await revealSecret(record);
  if (secret.kind !== "screen-time-pin") {
    throw new Error("This record does not contain a Screen Time PIN.");
  }
  return secret.pin;
}

function isCipherBox(value: unknown): value is CipherBox {
  if (!isPlainObject(value) || !hasExactKeys(value, CIPHER_BOX_KEYS)) {
    return false;
  }
  const box = value as Record<string, unknown>;
  return (
    typeof box.iv === "string" &&
    isCanonicalBase64(box.iv, { exactBytes: 12 }) &&
    typeof box.data === "string" &&
    isCanonicalBase64(box.data, {
      minBytes: 20,
      maxBytes: MAX_CIPHERTEXT_BYTES,
    })
  );
}

function isVaultRecord(value: unknown): value is VaultRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_KEYS)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    UUID_V4_PATTERN.test(record.id) &&
    typeof record.label === "string" &&
    isValidLabel(record.label) &&
    typeof record.minutes === "number" &&
    isValidMinutes(record.minutes) &&
    (record.kind === "screen-time-pin" ||
      record.kind === "recovery-credentials") &&
    typeof record.createdAt === "string" &&
    isCanonicalIsoTimestamp(record.createdAt) &&
    typeof record.seed === "string" &&
    isCanonicalBase64(record.seed, { exactBytes: 32 }) &&
    typeof record.salt === "string" &&
    isCanonicalBase64(record.salt, { exactBytes: 16 }) &&
    isCipherBox(record.secretBox)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}

function isValidLabel(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isValidSecretText(value: string, maxLength: number): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function isValidMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 60;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isCanonicalBase64(
  value: string,
  limits: {
    exactBytes?: number;
    minBytes?: number;
    maxBytes?: number;
  },
): boolean {
  if (!value || !BASE64_PATTERN.test(value)) return false;

  try {
    const bytes = base64ToBytes(value);
    if (bytesToBase64(bytes) !== value) return false;
    if (limits.exactBytes !== undefined && bytes.length !== limits.exactBytes) {
      return false;
    }
    if (limits.minBytes !== undefined && bytes.length < limits.minBytes) {
      return false;
    }
    if (limits.maxBytes !== undefined && bytes.length > limits.maxBytes) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseSecretPayload(value: string, expectedKind: VaultRecord["kind"]): VaultSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    if (expectedKind === "screen-time-pin" && /^\d{4}$/.test(value)) {
      return { kind: "screen-time-pin", pin: value };
    }
    throw new Error("Invalid secret data.");
  }

  if (!isPlainObject(parsed) || parsed.kind !== expectedKind) {
    throw new Error("Invalid secret data.");
  }

  if (expectedKind === "screen-time-pin") {
    const pin = parsed.pin;
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      throw new Error("Invalid PIN data.");
    }
    return { kind: "screen-time-pin", pin };
  }

  const secret = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(secret, [
      "kind",
      "recoveryEmail",
      "recoveryEmailPassword",
      "appleId",
      "appleIdPassword",
      "notes",
    ]) ||
    typeof secret.recoveryEmail !== "string" ||
    !isValidSecretText(secret.recoveryEmail, 320) ||
    typeof secret.recoveryEmailPassword !== "string" ||
    !isValidSecretText(secret.recoveryEmailPassword, 320) ||
    typeof secret.appleId !== "string" ||
    !isValidSecretText(secret.appleId, 320) ||
    typeof secret.appleIdPassword !== "string" ||
    !isValidSecretText(secret.appleIdPassword, 320) ||
    typeof secret.notes !== "string" ||
    (secret.notes.length > 0 && !isValidSecretText(secret.notes, 1_000))
  ) {
    throw new Error("Invalid recovery credential data.");
  }

  return {
    kind: "recovery-credentials",
    recoveryEmail: secret.recoveryEmail,
    recoveryEmailPassword: secret.recoveryEmailPassword,
    appleId: secret.appleId,
    appleIdPassword: secret.appleIdPassword,
    notes: secret.notes,
  };
}

export function parseBackup(value: string): VaultFile {
  if (
    value.length === 0 ||
    value.length > MAX_BACKUP_BYTES ||
    new TextEncoder().encode(value).byteLength > MAX_BACKUP_BYTES
  ) {
    throw new Error("This backup is empty or unexpectedly large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("This file is not valid JSON.");
  }

  if (!isPlainObject(parsed) || !hasExactKeys(parsed, VAULT_KEYS)) {
    throw new Error("This is not a Friction Vault backup.");
  }
  const vault = parsed as Partial<VaultFile>;
  if (
    vault.format !== "friction-vault" ||
    vault.version !== 1 ||
    typeof vault.createdAt !== "string" ||
    !isCanonicalIsoTimestamp(vault.createdAt) ||
    typeof vault.updatedAt !== "string" ||
    !isCanonicalIsoTimestamp(vault.updatedAt) ||
    vault.createdAt > vault.updatedAt ||
    !Array.isArray(vault.records) ||
    vault.records.length > MAX_RECORDS ||
    !vault.records.every(isVaultRecord)
  ) {
    throw new Error("This backup is damaged or uses an unsupported format.");
  }

  const recordIds = new Set<string>();
  for (const record of vault.records) {
    const id = record.id.toLowerCase();
    if (recordIds.has(id)) {
      throw new Error("This backup contains duplicate record IDs.");
    }
    recordIds.add(id);
  }

  return vault as VaultFile;
}

export function serializeBackup(vault: VaultFile): string {
  return JSON.stringify(vault, null, 2);
}

export function mergeVaults(current: VaultFile, incoming: VaultFile): VaultFile {
  const byId = new Map(current.records.map((record) => [record.id, record]));
  for (const record of incoming.records) byId.set(record.id, record);
  return {
    ...current,
    records: normalizeVaultRecords(Array.from(byId.values())),
  };
}

export function normalizeVaultRecords(records: VaultRecord[]): VaultRecord[] {
  const newestByKind = new Map<VaultRecord["kind"], VaultRecord>();

  for (const record of records) {
    const existing = newestByKind.get(record.kind);
    if (!existing || record.createdAt > existing.createdAt) {
      newestByKind.set(record.kind, record);
    }
  }

  return RECORD_KINDS.map((kind) => newestByKind.get(kind)).filter(
    (record): record is VaultRecord => !!record,
  );
}
