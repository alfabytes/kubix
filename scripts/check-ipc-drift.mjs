import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committed = path.join(root, "src/lib/ipc/schema/contract.json");
const typesFile = path.join(root, "src/lib/ipc/types.ts");

function fail(message) {
  console.error(`\n✖ IPC contract drift: ${message}\n`);
  process.exit(1);
}

const contractSource = path.join(root, "src-tauri/src/ipc/contract.rs");

if (!process.env.KUBIX_SKIP_RUST) {
  const tmp = mkdtempSync(path.join(tmpdir(), "kubix-ipc-"));
  const generated = path.join(tmp, "contract.json");
  try {
    execFileSync(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        "src-tauri/crates/ipc-schema/Cargo.toml",
        "--",
        "--out",
        generated,
      ],
      { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
    );
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    fail(`could not regenerate contract from Rust (${err?.message ?? err})`);
  }

  const freshText = readFileSync(generated, "utf8");
  rmSync(tmp, { recursive: true, force: true });

  let existingText;
  try {
    existingText = readFileSync(committed, "utf8");
  } catch {
    fail(`${path.relative(root, committed)} is missing; run \`pnpm ipc:schema\``);
  }

  if (freshText !== existingText) {
    fail(
      `${path.relative(root, committed)} is stale. Run \`pnpm ipc:schema\` and commit the result.`,
    );
  }

  // Inverse guard: a new DTO must be registered in the contract emitter, otherwise a
  // Rust-only type would never reach the frontend.
  const registered = readFileSync(contractSource, "utf8");
  for (const name of Object.keys(JSON.parse(existingText).schemas ?? {})) {
    if (!new RegExp(`"${name}"`).test(registered)) {
      fail(`DTO '${name}' is generated but not registered in contract.rs`);
    }
  }
}

const contract = JSON.parse(readFileSync(committed, "utf8"));
const typeSource = readFileSync(typesFile, "utf8");

const schemaProps = new Set();
function collect(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) schemaProps.add(key);
  }
  for (const defsKey of ["definitions", "$defs"]) {
    if (schema[defsKey]) {
      for (const def of Object.values(schema[defsKey])) collect(def);
    }
  }
  if (schema.items) collect(schema.items);
  for (const branchKey of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[branchKey])) schema[branchKey].forEach(collect);
  }
}

for (const schema of Object.values(contract.schemas ?? {})) collect(schema);

const missing = [...schemaProps].filter(
  (name) => !new RegExp(`\\b${name}\\s*[?]?\\s*:`).test(typeSource),
);
if (missing.length > 0) {
  fail(
    `src/lib/ipc/types.ts is missing ${missing.length} field(s) present in the Rust contract: ${missing
      .sort()
      .join(", ")}`,
  );
}

for (const name of schemaProps) {
  if (name.includes("_")) fail(`contract field '${name}' is not camelCase`);
}

for (const cmd of contract.commands ?? []) {
  if (!cmd.readOnly) fail(`command '${cmd.name}' is not read-only`);
  if (!new RegExp(`\\b${cmd.name}\\b`).test(typeSource) && !new RegExp(`\\b${cmd.name}\\b`).test(readFileSync(path.join(root, "src/lib/ipc/client.ts"), "utf8"))) {
    fail(`command '${cmd.name}' is not referenced by the frontend IPC client`);
  }
}

for (const event of contract.events ?? []) {
  const eventsSource = readFileSync(path.join(root, "src/lib/ipc/events.ts"), "utf8");
  if (!eventsSource.includes(event.name)) {
    fail(`event '${event.name}' is not handled in src/lib/ipc/events.ts`);
  }
}

console.log(
  `✔ IPC contract in sync (${contract.commands?.length ?? 0} commands, ${
    contract.events?.length ?? 0
  } events, ${schemaProps.size} fields)`,
);

void writeFileSync;
