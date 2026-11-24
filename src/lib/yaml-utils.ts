/**
 * Strips server-generated Kubernetes metadata and status noise from a YAML manifest
 * so the exported or diffed manifest is clean, portable, and focused on real spec changes.
 */
const METADATA_NOISE_KEYS = new Set([
  "managedFields",
  "resourceVersion",
  "uid",
  "generation",
  "selfLink",
  "creationTimestamp",
]);

const ANNOTATION_NOISE_KEYS = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
]);

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  return i;
}

function keyNameOf(trimmed: string): string | null {
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) return null;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx <= 0) return null;
  const raw = trimmed.slice(0, colonIdx).trim();
  return raw.replace(/^['"]|['"]$/g, "");
}

export function stripYamlNoise(
  rawYaml: string,
  options: { stripStatus?: boolean } = {},
): string {
  const { stripStatus = true } = options;
  if (!rawYaml.trim()) return rawYaml;

  const lines = rawYaml.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  let i = 0;
  let inMetadata = false;
  let metadataIndent = -1;
  let inAnnotations = false;
  let annotationsIndent = -1;

  const skipBlock = (startIdx: number, baseIndent: number): number => {
    let idx = startIdx + 1;
    while (idx < lines.length) {
      const next = lines[idx]!;
      const trimmed = next.trim();
      if (trimmed === "") {
        idx += 1;
        continue;
      }
      const nextIndent = indentOf(next);
      // Nested lines or sequence items indented at or deeper than the block key
      if (nextIndent > baseIndent || (nextIndent === baseIndent && trimmed.startsWith("- "))) {
        idx += 1;
        continue;
      }
      break;
    }
    return idx;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      out.push(line);
      i += 1;
      continue;
    }

    const indent = indentOf(line);

    if (inAnnotations && indent <= annotationsIndent) {
      inAnnotations = false;
      annotationsIndent = -1;
    }
    if (inMetadata && indent <= metadataIndent) {
      inMetadata = false;
      metadataIndent = -1;
    }

    const key = keyNameOf(trimmed);

    // Top-level keys
    if (indent === 0 && key) {
      if (key === "status" && stripStatus) {
        i = skipBlock(i, indent);
        continue;
      }
      if (key === "metadata") {
        inMetadata = true;
        metadataIndent = indent;
      }
    } else if (inMetadata && !inAnnotations && key) {
      // Direct child of metadata:
      if (indent > metadataIndent && METADATA_NOISE_KEYS.has(key)) {
        i = skipBlock(i, indent);
        continue;
      }
      if (key === "annotations") {
        inAnnotations = true;
        annotationsIndent = indent;
        out.push(line);
        i += 1;
        continue;
      }
    } else if (inAnnotations && key && indent > annotationsIndent) {
      if (ANNOTATION_NOISE_KEYS.has(key)) {
        i = skipBlock(i, indent);
        continue;
      }
    }

    out.push(line);
    i += 1;
  }

  // Remove empty `annotations:` header if all of its entries were stripped
  const cleaned: string[] = [];
  for (let idx = 0; idx < out.length; idx += 1) {
    const line = out[idx]!;
    if (line.trim() === "annotations:") {
      const annIndent = indentOf(line);
      let nextNonEmpty = idx + 1;
      while (nextNonEmpty < out.length && out[nextNonEmpty]!.trim() === "") {
        nextNonEmpty += 1;
      }
      const hasChild =
        nextNonEmpty < out.length && indentOf(out[nextNonEmpty]!) > annIndent;
      if (!hasChild) {
        continue;
      }
    }
    cleaned.push(line);
  }

  return `${cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
