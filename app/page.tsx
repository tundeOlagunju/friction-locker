"use client";

import {
  type FormEvent,
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ROUNDS_PER_MINUTE,
  buildPinInstructions,
  createCountingPuzzle,
  generatePin,
  type CountingPuzzle,
  type PinInstruction,
} from "../lib/challenges";
import {
  loadVault,
  mergeVaults,
  normalizeVaultRecords,
  parseBackup,
  revealPin,
  revealSecret,
  saveVault,
  sealPin,
  sealRecoveryCredentials,
  serializeBackup,
  type VaultSecret,
  type VaultFile,
  type VaultRecord,
} from "../lib/vault";

type View =
  | "dashboard"
  | "create"
  | "create-recovery"
  | "generator"
  | "challenge"
  | "reveal"
  | "backups"
  | "about";

type GeneratorState = {
  draft: VaultRecord;
  phase: "first" | "between" | "verify";
  steps: PinInstruction[];
  stepIndex: number;
};

type ChallengeState = {
  record: VaultRecord;
  source: "device" | "backup";
  solved: number;
  total: number;
  mistakes: number;
  puzzle: CountingPuzzle;
};

const GENERATOR_STORAGE_KEY = "friction-vault:generator:v1";
const LAST_BACKUP_KEY = "friction-vault:last-backup";
const RETRIEVAL_MINUTES = [1, 5, 10, 15, 20, 30];

function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function recordKindLabel(record: VaultRecord): string {
  return record.kind === "screen-time-pin"
    ? "Screen Time PIN"
    : "Recovery credentials";
}

function isGeneratorState(value: unknown): value is GeneratorState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GeneratorState>;
  return (
    !!state.draft &&
    (state.phase === "first" ||
      state.phase === "between" ||
      state.phase === "verify") &&
    Array.isArray(state.steps) &&
    Number.isInteger(state.stepIndex) &&
    (state.stepIndex ?? -1) >= 0
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brand-compact" : "brand"}>
      <span className="brand-mark" aria-hidden="true">
        <span />
      </span>
      <span>
        <strong>Friction Vault</strong>
        {!compact && <small>Pause the impulse. Keep the choice.</small>}
      </span>
    </div>
  );
}

function Header({
  onHome,
  onBackups,
}: {
  onHome: () => void;
  onBackups: () => void;
}) {
  return (
    <header className="app-header">
      <button className="brand-button" type="button" onClick={onHome}>
        <Brand compact />
      </button>
      <nav aria-label="Vault navigation">
        <button className="text-button" type="button" onClick={onBackups}>
          Backup
        </button>
      </nav>
    </header>
  );
}

export default function Home() {
  const [vault, setVault] = useState<VaultFile | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [label, setLabel] = useState("iPhone Screen Time");
  const [minutes, setMinutes] = useState(10);
  const [recoveryLabel, setRecoveryLabel] = useState("Screen Time Recovery");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryEmailPassword, setRecoveryEmailPassword] = useState("");
  const [appleId, setAppleId] = useState("");
  const [appleIdPassword, setAppleIdPassword] = useState("");
  const [recoveryNotes, setRecoveryNotes] = useState("");
  const [generator, setGenerator] = useState<GeneratorState | null>(null);
  const [challenge, setChallenge] = useState<ChallengeState | null>(null);
  const [guess, setGuess] = useState("");
  const [challengeMessage, setChallengeMessage] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<VaultSecret | null>(null);
  const [revealUntil, setRevealUntil] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [incomingVault, setIncomingVault] = useState<VaultFile | null>(null);
  const [incomingName, setIncomingName] = useState("");
  const [lastBackupAt, setLastBackupAt] = useState("");
  const guessRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    loadVault()
      .then((loaded) => {
        if (!active) return;
        setVault(loaded);
        setLastBackupAt(localStorage.getItem(LAST_BACKUP_KEY) ?? "");

        const savedGenerator = localStorage.getItem(GENERATOR_STORAGE_KEY);
        if (!savedGenerator) return;
        try {
          const parsed: unknown = JSON.parse(savedGenerator);
          if (isGeneratorState(parsed)) {
            setGenerator(parsed);
            setView("generator");
          } else {
            localStorage.removeItem(GENERATOR_STORAGE_KEY);
          }
        } catch {
          localStorage.removeItem(GENERATOR_STORAGE_KEY);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The local vault could not be opened.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (generator) {
      localStorage.setItem(GENERATOR_STORAGE_KEY, JSON.stringify(generator));
    } else {
      localStorage.removeItem(GENERATOR_STORAGE_KEY);
    }
  }, [generator]);

  useEffect(() => {
    if (view !== "challenge") return;
    const timer = window.setTimeout(() => guessRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [challenge?.puzzle, view]);

  useEffect(() => {
    if (!revealUntil) return;
    const update = () => {
      const remaining = Math.max(
        0,
        Math.ceil((revealUntil - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setRevealedSecret(null);
        setRevealUntil(0);
        setView("dashboard");
      }
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [revealUntil]);

  const backupIsStale = useMemo(() => {
    if (!vault?.records.length) return false;
    if (!lastBackupAt) return true;
    return Date.parse(lastBackupAt) < Date.parse(vault.updatedAt);
  }, [lastBackupAt, vault]);
  const vaultRecords = useMemo(
    () => normalizeVaultRecords(vault?.records ?? []),
    [vault?.records],
  );
  const screenTimeRecord = vaultRecords.find(
    (record) => record.kind === "screen-time-pin",
  );
  const recoveryRecord = vaultRecords.find(
    (record) => record.kind === "recovery-credentials",
  );
  const incomingRecords = useMemo(
    () => normalizeVaultRecords(incomingVault?.records ?? []),
    [incomingVault?.records],
  );

  const resetMessages = () => {
    setError("");
    setNotice("");
  };

  const goHome = () => {
    if (view === "generator" && generator) {
      const leave = window.confirm(
        "Leave PIN setup? The unfinished PIN will be discarded.",
      );
      if (!leave) return;
      setGenerator(null);
    }
    setChallenge(null);
    setRevealedSecret(null);
    resetMessages();
    setView("dashboard");
  };

  const beginPinSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    resetMessages();
    const cleanLabel = label.trim();
    if (!cleanLabel) {
      setError("Give this PIN a label.");
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      setError("Choose a retrieval time between 1 and 60 minutes.");
      return;
    }

    try {
      const pin = generatePin();
      const draft = await sealPin({ pin, label: cleanLabel, minutes });
      setGenerator({
        draft,
        phase: "first",
        steps: buildPinInstructions(pin),
        stepIndex: 0,
      });
      setView("generator");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "PIN setup could not start.",
      );
    }
  };

  const saveRecoveryCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!vault) return;
    resetMessages();

    try {
      const record = await sealRecoveryCredentials({
        label: recoveryLabel,
        minutes,
        recoveryEmail,
        recoveryEmailPassword,
        appleId,
        appleIdPassword,
        notes: recoveryNotes,
      });
      const saved = await saveVault({
        ...vault,
        records: [
          record,
          ...vault.records.filter((item) => item.kind !== record.kind),
        ],
      });
      setVault(saved);
      setRecoveryLabel("Screen Time Recovery");
      setRecoveryEmail("");
      setRecoveryEmailPassword("");
      setAppleId("");
      setAppleIdPassword("");
      setRecoveryNotes("");
      setNotice(
        recoveryRecord
          ? "Recovery credentials replaced. Export a fresh backup before you rely on them."
          : "Recovery credentials sealed. Export a fresh backup before you rely on them.",
      );
      setView("dashboard");
      void navigator.storage?.persist?.();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Recovery credentials could not be saved.",
      );
    }
  };

  const advanceGenerator = async () => {
    if (!generator || !vault) return;
    resetMessages();

    if (generator.phase === "between") {
      try {
        const pin = await revealPin(generator.draft);
        setGenerator({
          ...generator,
          phase: "verify",
          steps: buildPinInstructions(pin),
          stepIndex: 0,
        });
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The confirmation sequence could not start.",
        );
      }
      return;
    }

    if (generator.stepIndex < generator.steps.length - 1) {
      setGenerator({
        ...generator,
        stepIndex: generator.stepIndex + 1,
      });
      return;
    }

    if (generator.phase === "first") {
      setGenerator({
        ...generator,
        phase: "between",
        stepIndex: 0,
      });
      return;
    }

    try {
      const replacing = vault.records.some(
        (record) => record.kind === generator.draft.kind,
      );
      const saved = await saveVault({
        ...vault,
        records: [
          generator.draft,
          ...vault.records.filter((item) => item.kind !== generator.draft.kind),
        ],
      });
      setVault(saved);
      setGenerator(null);
      setNotice(
        replacing
          ? "PIN replaced on this device. Export a fresh backup before you rely on it."
          : "PIN sealed on this device. Export a fresh backup before you rely on it.",
      );
      setView("dashboard");
      void navigator.storage?.persist?.();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The PIN could not be saved.",
      );
    }
  };

  const startChallenge = (
    record: VaultRecord,
    source: "device" | "backup" = "device",
  ) => {
    resetMessages();
    setGuess("");
    setChallengeMessage("");
    setChallenge({
      record,
      source,
      solved: 0,
      total: record.minutes * ROUNDS_PER_MINUTE,
      mistakes: 0,
      puzzle: createCountingPuzzle(),
    });
    setView("challenge");
  };

  const submitChallenge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!challenge) return;
    const numericGuess = Number(guess);
    if (!Number.isInteger(numericGuess) || numericGuess < 0 || numericGuess > 50) {
      setChallengeMessage("Enter a whole number from 0 to 50.");
      return;
    }

    setGuess("");
    if (numericGuess !== challenge.puzzle.answer) {
      setChallenge({
        ...challenge,
        solved: Math.max(0, challenge.solved - 1),
        mistakes: challenge.mistakes + 1,
        puzzle: createCountingPuzzle(),
      });
      setChallengeMessage(
        challenge.solved > 0
          ? "Not quite. A fresh grid replaced it and one solve was removed."
          : "Not quite. A fresh grid replaced it.",
      );
      return;
    }

    const solved = challenge.solved + 1;
    if (solved < challenge.total) {
      setChallenge({
        ...challenge,
        solved,
        puzzle: createCountingPuzzle(),
      });
      setChallengeMessage("Correct.");
      return;
    }

    try {
      const secret = await revealSecret(challenge.record);
      setRevealedSecret(secret);
      setChallenge(null);
      setRevealUntil(Date.now() + 90_000);
      setView("reveal");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The record could not be opened.",
      );
      setView(challenge.source === "backup" ? "backups" : "dashboard");
    }
  };

  const deleteRecord = async (record: VaultRecord) => {
    if (!vault) return;
    const confirmed = window.confirm(
      `Delete “${record.label}” from this device? Exported backups will not be changed.`,
    );
    if (!confirmed) return;
    try {
      const saved = await saveVault({
        ...vault,
        records: vault.records.filter((item) => item.id !== record.id),
      });
      setVault(saved);
      setNotice("Record deleted from this device.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The record could not be deleted.",
      );
    }
  };

  const exportBackup = async () => {
    if (!vault) return;
    resetMessages();
    const timestamp = new Date()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/[:]/g, "-");
    const filename = `friction-vault-${timestamp}.friction-vault`;
    const backupVault = {
      ...vault,
      records: vaultRecords,
    };
    const file = new File([serializeBackup(backupVault)], filename, {
      type: "application/json",
    });

    try {
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            title: "Friction Vault backup",
            text: "Save this backup somewhere you can reach from a replacement phone.",
            files: [file],
          });
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          downloadFile(file);
        }
      } else {
        downloadFile(file);
      }
      localStorage.setItem(LAST_BACKUP_KEY, vault.updatedAt);
      setLastBackupAt(vault.updatedAt);
      setNotice("Backup prepared. Keep it somewhere separate from this phone.");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(
        cause instanceof Error ? cause.message : "The backup could not be exported.",
      );
    }
  };

  const readBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    resetMessages();
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2_000_000) {
        throw new Error("That backup is unexpectedly large.");
      }
      const parsed = parseBackup(await file.text());
      const records = normalizeVaultRecords(parsed.records);
      setIncomingVault(parsed);
      setIncomingName(file.name);
      setNotice(
        `Opened ${records.length} saved item${records.length === 1 ? "" : "s"} from ${file.name}.`,
      );
      setView("backups");
    } catch (cause) {
      setIncomingVault(null);
      setError(
        cause instanceof Error ? cause.message : "That backup could not be opened.",
      );
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const restoreIncoming = async () => {
    if (!vault || !incomingVault) return;
    const confirmed = window.confirm(
      "Merge every item from this backup into the vault on this device?",
    );
    if (!confirmed) return;
    try {
      const merged = await saveVault(mergeVaults(vault, incomingVault));
      setVault(merged);
      setIncomingVault(null);
      setIncomingName("");
      setNotice("Backup restored to this device. Export a fresh combined backup.");
      setView("dashboard");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The backup could not be restored.",
      );
    }
  };

  if (!vault && !error) {
    return (
      <main className="loading-screen">
        <Brand />
        <div className="loading-line" aria-label="Opening local vault" />
        <p>Opening your local vault…</p>
      </main>
    );
  }

  if (!vault) {
    return (
      <main className="loading-screen">
        <Brand />
        <section className="error-card" role="alert">
          <h1>The vault could not open</h1>
          <p>{error}</p>
          <button className="primary-button" onClick={() => location.reload()}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  const currentStep =
    generator?.phase === "first" || generator?.phase === "verify"
      ? generator.steps[generator.stepIndex]
      : null;

  return (
    <main className="app-shell">
      <Header
        onHome={goHome}
        onBackups={() => {
          resetMessages();
          setView("backups");
        }}
      />

      {(error || notice) && (
        <div
          className={error ? "toast toast-error" : "toast"}
          role={error ? "alert" : "status"}
        >
          <span>{error || notice}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={resetMessages}
          >
            ×
          </button>
        </div>
      )}

      {view === "dashboard" && (
        <section className="page dashboard-page">
          <div className="dashboard-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                resetMessages();
                setView("create");
              }}
            >
              <span aria-hidden="true">{screenTimeRecord ? "↻" : "＋"}</span>{" "}
              {screenTimeRecord ? "Replace Screen Time PIN" : "Create a Screen Time PIN"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                resetMessages();
                setView("create-recovery");
              }}
            >
              {recoveryRecord ? "Replace recovery credentials" : "Add recovery credentials"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                resetMessages();
                setView("backups");
              }}
            >
              Open a backup
            </button>
          </div>

          <div className="section-heading">
            <div>
              <p className="kicker">Your vault</p>
              <h2>
                {vaultRecords.length
                  ? `${vaultRecords.length} sealed item${vaultRecords.length === 1 ? "" : "s"}`
                  : "No items yet"}
              </h2>
            </div>
          </div>

          {vaultRecords.length === 0 ? (
            <div className="empty-card">
              <span className="empty-icon" aria-hidden="true">
                0
              </span>
              <div>
                <h3>Your first lock starts here</h3>
                <p>Create the PIN, then add recovery credentials.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="vault-toolbar">
                <button
                  className={backupIsStale ? "mini-button warning" : "mini-button"}
                  type="button"
                  onClick={() => void exportBackup()}
                >
                  {backupIsStale ? "Export backup" : "Backup"}
                </button>
                {lastBackupAt && <small>Last: {formatDate(lastBackupAt)}</small>}
              </div>
              <div className="record-list">
                {vaultRecords.map((record, index) => (
                  <article className="record-card" key={record.id}>
                    <div className="record-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="record-copy">
                      <h3>{record.label}</h3>
                      <p>
                        {recordKindLabel(record)} · {record.minutes} min ·{" "}
                        {formatDate(record.createdAt)}
                      </p>
                    </div>
                    <button
                      className="retrieve-button"
                      type="button"
                      onClick={() => startChallenge(record)}
                    >
                      Retrieve <span aria-hidden="true">→</span>
                    </button>
                    <button
                      className="icon-button delete-button"
                      type="button"
                      aria-label={`Delete ${record.label}`}
                      onClick={() => void deleteRecord(record)}
                    >
                      ×
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {view === "create" && (
        <section className="page narrow-page">
          <button className="back-button" type="button" onClick={goHome}>
            ← Back to vault
          </button>
          <div className="page-intro">
            <p className="kicker">New lock</p>
            <h1>
              {screenTimeRecord
                ? "Replace the PIN you won’t learn."
                : "Create a PIN you won’t learn."}
            </h1>
            <p>Keep Screen Time Settings open.</p>
          </div>

          <form className="form-card" onSubmit={beginPinSetup}>
            <label>
              PIN label
              <input
                value={label}
                maxLength={120}
                onChange={(event) => setLabel(event.target.value)}
                autoComplete="off"
              />
              <small>Example: “iPhone Screen Time”.</small>
            </label>

            <fieldset>
              <legend>Retrieval challenge</legend>
              <div className="time-options">
                {RETRIEVAL_MINUTES.map((option) => (
                  <button
                    className={minutes === option ? "time-option selected" : "time-option"}
                    type="button"
                    key={option}
                    aria-pressed={minutes === option}
                    onClick={() => setMinutes(option)}
                  >
                    <strong>{option}</strong>
                    <small>min</small>
                  </button>
                ))}
              </div>
              <p className="field-note">
                {minutes * ROUNDS_PER_MINUTE} number grids · approximately{" "}
                {minutes} {minutes === 1 ? "minute" : "minutes"}
              </p>
            </fieldset>

            <div className="setup-note">
              <span aria-hidden="true">i</span>
              <p>Open <strong>Settings → Screen Time</strong> before starting.</p>
            </div>

            <button className="primary-button full-button" type="submit">
              Begin guided setup <span aria-hidden="true">→</span>
            </button>
          </form>
        </section>
      )}

      {view === "create-recovery" && (
        <section className="page narrow-page">
          <button className="back-button" type="button" onClick={goHome}>
            ← Back to vault
          </button>
          <div className="page-intro">
            <p className="kicker">Recovery lock</p>
            <h1>
              {recoveryRecord
                ? "Replace the recovery escape hatch."
                : "Seal the Apple ID escape hatch."}
            </h1>
            <p>Store the separate Apple ID used for Screen Time recovery.</p>
          </div>

          <form className="form-card" onSubmit={saveRecoveryCredentials}>
            <label>
              Label
              <input
                value={recoveryLabel}
                maxLength={120}
                onChange={(event) => setRecoveryLabel(event.target.value)}
                autoComplete="off"
              />
              <small>Example: “Screen Time Recovery”.</small>
            </label>

            <label>
              Recovery email
              <input
                value={recoveryEmail}
                maxLength={320}
                onChange={(event) => setRecoveryEmail(event.target.value)}
                autoComplete="off"
                inputMode="email"
              />
              <small>Email for the recovery Apple ID.</small>
            </label>

            <label>
              Recovery email password
              <input
                value={recoveryEmailPassword}
                maxLength={320}
                onChange={(event) => setRecoveryEmailPassword(event.target.value)}
                autoComplete="new-password"
                type="password"
              />
            </label>

            <label>
              Recovery Apple ID
              <input
                value={appleId}
                maxLength={320}
                onChange={(event) => setAppleId(event.target.value)}
                autoComplete="off"
                inputMode="email"
              />
              <small>Used in Screen Time passcode recovery.</small>
            </label>

            <label>
              Recovery Apple ID password
              <input
                value={appleIdPassword}
                maxLength={320}
                onChange={(event) => setAppleIdPassword(event.target.value)}
                autoComplete="new-password"
                type="password"
              />
            </label>

            <label>
              Notes
              <textarea
                value={recoveryNotes}
                maxLength={1000}
                onChange={(event) => setRecoveryNotes(event.target.value)}
                placeholder="Optional"
              />
            </label>

            <fieldset>
              <legend>Retrieval challenge</legend>
              <div className="time-options">
                {RETRIEVAL_MINUTES.map((option) => (
                  <button
                    className={minutes === option ? "time-option selected" : "time-option"}
                    type="button"
                    key={option}
                    aria-pressed={minutes === option}
                    onClick={() => setMinutes(option)}
                  >
                    <strong>{option}</strong>
                    <small>min</small>
                  </button>
                ))}
              </div>
              <p className="field-note">
                {minutes * ROUNDS_PER_MINUTE} number grids · approximately{" "}
                {minutes} {minutes === 1 ? "minute" : "minutes"}
              </p>
            </fieldset>

            <div className="setup-note">
              <span aria-hidden="true">i</span>
              <p>Create the accounts first, then seal them here.</p>
            </div>

            <button className="primary-button full-button" type="submit">
              Seal recovery credentials <span aria-hidden="true">→</span>
            </button>
          </form>
        </section>
      )}

      {view === "generator" && generator && (
        <section className="ceremony-page">
          <div className="ceremony-top">
            <Brand compact />
            <button
              className="text-button light-text"
              type="button"
              onClick={goHome}
            >
              Cancel setup
            </button>
          </div>

          {generator.phase === "between" ? (
            <div className="ceremony-card intermission-card">
              <span className="step-pill">First entry complete</span>
              <div className="confirmation-mark" aria-hidden="true">
                ✓
              </div>
              <h1>Now confirm it in Settings.</h1>
              <p>
                Screen Time should be asking you to re-enter the new passcode.
                Leave that screen open, then start a fresh instruction sequence.
              </p>
              <button
                className="ceremony-button"
                type="button"
                onClick={() => void advanceGenerator()}
              >
                Start confirmation <span aria-hidden="true">→</span>
              </button>
            </div>
          ) : (
            <div className="ceremony-card">
              <div className="ceremony-meta">
                <span className="step-pill">
                  {generator.phase === "first" ? "Set PIN" : "Confirm PIN"}
                </span>
                <span>
                  Step {generator.stepIndex + 1} of {generator.steps.length}
                </span>
              </div>
              <div className="step-progress" aria-hidden="true">
                <span
                  style={{
                    width: `${((generator.stepIndex + 1) / generator.steps.length) * 100}%`,
                  }}
                />
              </div>

              <p className="instruction-lead">In Screen Time Settings</p>
              <h1 className={currentStep?.action === "delete" ? "delete-command" : ""}>
                {currentStep?.action === "delete"
                  ? "Press delete"
                  : `Enter ${currentStep?.digit}`}
              </h1>

              <div className="pin-dots" aria-label="Current PIN field length">
                {[0, 1, 2, 3].map((slot) => (
                  <span
                    className={
                      slot < (currentStep?.afterLength ?? 0) ? "filled" : ""
                    }
                    key={slot}
                  />
                ))}
              </div>

              <p className="switch-hint">
                Switch to Settings, do exactly this, then return here.
              </p>
              <button
                className="ceremony-button"
                type="button"
                onClick={() => void advanceGenerator()}
              >
                I did this <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
        </section>
      )}

      {view === "challenge" && challenge && (
        <section className="challenge-page">
          <div className="challenge-topbar">
            <button
              className="back-button"
              type="button"
              onClick={() => {
                const quit = window.confirm(
                  "Stop retrieval? Your progress will be discarded.",
                );
                if (quit) {
                  setChallenge(null);
                  setView(challenge.source === "backup" ? "backups" : "dashboard");
                }
              }}
            >
              ← Stop
            </button>
            <div>
              <strong>{challenge.record.label}</strong>
              <small>
                {challenge.source === "backup" ? "Opened from backup" : "On this device"}
              </small>
            </div>
            <span className="solve-count">
              {challenge.solved}/{challenge.total}
            </span>
          </div>

          <div className="challenge-progress" aria-label="Retrieval progress">
            <span
              style={{
                width: `${(challenge.solved / challenge.total) * 100}%`,
              }}
            />
          </div>

          <div className="challenge-content">
            <p className="kicker">Count carefully</p>
            <h1>
              How many <mark>{challenge.puzzle.target}s</mark> are in the grid?
            </h1>
            <div className="number-grid" aria-label="Grid of fifty digits">
              {challenge.puzzle.digits.map((digit, index) => (
                <span key={index}>{digit}</span>
              ))}
            </div>

            <form className="answer-form" onSubmit={submitChallenge}>
              <label htmlFor="count-answer">Your count</label>
              <div>
                <input
                  ref={guessRef}
                  id="count-answer"
                  value={guess}
                  onChange={(event) =>
                    setGuess(event.target.value.replace(/\D/g, "").slice(0, 2))
                  }
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  aria-describedby="challenge-feedback"
                />
                <button type="submit">Check</button>
              </div>
              <p
                id="challenge-feedback"
                className={
                  challengeMessage.startsWith("Correct")
                    ? "challenge-feedback correct"
                    : "challenge-feedback"
                }
                aria-live="polite"
              >
                {challengeMessage || "Wrong answers generate a new grid."}
              </p>
            </form>
          </div>
        </section>
      )}

      {view === "reveal" && revealedSecret && (
        <section className="reveal-page">
          <div className="reveal-card">
            <span className="step-pill">Challenge complete</span>
            {revealedSecret.kind === "screen-time-pin" ? (
              <>
                <p className="kicker">Your Screen Time PIN</p>
                <div
                  className="revealed-pin"
                  aria-label={`PIN ${revealedSecret.pin}`}
                >
                  {revealedSecret.pin.split("").map((digit, index) => (
                    <span key={index}>{digit}</span>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="kicker">Recovery credentials</p>
                <div className="secret-fields">
                  <div>
                    <small>Recovery email</small>
                    <strong>{revealedSecret.recoveryEmail}</strong>
                  </div>
                  <div>
                    <small>Email password</small>
                    <strong>{revealedSecret.recoveryEmailPassword}</strong>
                  </div>
                  <div>
                    <small>Recovery Apple ID</small>
                    <strong>{revealedSecret.appleId}</strong>
                  </div>
                  <div>
                    <small>Apple ID password</small>
                    <strong>{revealedSecret.appleIdPassword}</strong>
                  </div>
                  {revealedSecret.notes && (
                    <div className="wide-secret">
                      <small>Notes</small>
                      <strong>{revealedSecret.notes}</strong>
                    </div>
                  )}
                </div>
              </>
            )}
            <p className="reveal-timer">
              Hidden automatically in <strong>{secondsLeft}s</strong>
            </p>
            <p className="reveal-help">
              Use it now. This screen will remain available briefly while the
              app is in the background.
            </p>
            <button
              className="primary-button full-button"
              type="button"
              onClick={goHome}
            >
              Hide now
            </button>
          </div>
        </section>
      )}

      {view === "backups" && (
        <section className="page narrow-page backup-page">
          <button className="back-button" type="button" onClick={goHome}>
            ← Back to vault
          </button>
          <div className="page-intro">
            <p className="kicker">Import</p>
            <h1>Open a backup.</h1>
          </div>

          <article className="backup-card single-backup-card">
            <h2>Choose backup file</h2>
            <p>Retrieve from the file or merge it into this device.</p>
            <input
              ref={fileRef}
              className="file-input"
              id="backup-file"
              type="file"
              accept=".friction-vault,application/json"
              onChange={(event) => void readBackup(event)}
            />
            <label className="secondary-button full-button" htmlFor="backup-file">
              Choose file
            </label>
          </article>

          {incomingVault && (
            <section className="incoming-panel">
              <div className="incoming-heading">
                <div>
                  <p className="kicker">Currently open</p>
                  <h2>{incomingName}</h2>
                </div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setIncomingVault(null);
                    setIncomingName("");
                  }}
                >
                  Close file
                </button>
              </div>

              {incomingRecords.length ? (
                <div className="record-list compact-records">
                  {incomingRecords.map((record, index) => (
                    <article className="record-card" key={record.id}>
                      <div className="record-index" aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </div>
                      <div className="record-copy">
                        <h3>{record.label}</h3>
                        <p>
                          {recordKindLabel(record)} · {record.minutes} min
                        </p>
                      </div>
                      <button
                        className="retrieve-button"
                        type="button"
                        onClick={() => startChallenge(record, "backup")}
                      >
                        Retrieve <span aria-hidden="true">→</span>
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty-backup">This backup contains no items.</p>
              )}

              <button
                className="secondary-button full-button"
                type="button"
                disabled={!incomingRecords.length}
                onClick={() => void restoreIncoming()}
              >
                Merge all into this device
              </button>
            </section>
          )}

          <div className="boundary-note">
            <strong>One file contains the vault.</strong>
            <p>PIN and recovery credentials export together.</p>
          </div>
        </section>
      )}

      {view === "about" && (
        <section className="page narrow-page about-page">
          <button className="back-button" type="button" onClick={goHome}>
            ← Back to vault
          </button>
          <div className="page-intro">
            <p className="kicker">The honest promise</p>
            <h1>Designed for an impulse—not an attacker.</h1>
            <p>
              Friction Vault gives future-you time to reconsider without handing
              your PIN to a company or another person.
            </p>
          </div>

          <div className="principle-list">
            <article>
              <span>01</span>
              <div>
                <h2>Your PIN stays local</h2>
                <p>
                  Generation, storage, challenges, backup opening, and decryption
                  all happen in this browser on this device.
                </p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h2>The challenge is behavioural</h2>
                <p>
                  It makes normal retrieval tedious enough to interrupt a quick
                  decision. Someone deliberately changing the open-source code can
                  bypass it.
                </p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h2>Backups are essential</h2>
                <p>
                  Browser data can be deleted with the app or device. Export after
                  every change and keep the file away from the phone.
                </p>
              </div>
            </article>
          </div>
        </section>
      )}
    </main>
  );
}
