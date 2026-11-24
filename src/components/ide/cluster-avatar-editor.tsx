import { useEffect, useRef, useState } from "react";
import { Pencil, Pin, PinOff, Plus, RotateCcw, Shuffle, X } from "lucide-react";

import {
  AVATAR_COLOR_SWATCHES,
  AVATAR_EYES,
  AVATAR_SHAPES,
  CharacterAvatarSvg,
  ClusterAvatar,
  getClusterProfileMeta,
} from "@/components/ide/cluster-avatar";
import { Button } from "@/components/ui/button";
import {
  useClusterProfileStore,
  type AvatarEyes,
  type AvatarFinish,
  type AvatarShape,
  type ClusterAvatarConfig,
} from "@/stores/cluster-profile-store";

export interface ClusterAvatarEditorProps {
  contextId: string;
  contextName: string;
  onClose: () => void;
}

async function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        reject(new Error("Empty file"));
        return;
      }
      // Preserve GIF/SVG/WebP raw data URL so animations & vector crispness survive intact.
      if (
        file.type === "image/gif" ||
        file.type === "image/svg+xml" ||
        file.type === "image/webp" ||
        file.size <= 120 * 1024
      ) {
        resolve(result);
        return;
      }
      // Square-crop and resize larger static PNG/JPGs to 128x128 for fast persistence.
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const size = 128;
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(result);
            return;
          }
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(result);
        }
      };
      img.onerror = () => resolve(result);
      img.src = result;
    };
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.readAsDataURL(file);
  });
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] ?? items[0]!;
}

export function ClusterAvatarEditor({
  contextId,
  contextName,
  onClose,
}: ClusterAvatarEditorProps) {
  const existing = useClusterProfileStore((s) => s.avatars[contextId]);
  const pinned = useClusterProfileStore((s) => s.pinnedIds.includes(contextId));
  const togglePin = useClusterProfileStore((s) => s.togglePin);
  const setAvatar = useClusterProfileStore((s) => s.setAvatar);
  const resetAvatar = useClusterProfileStore((s) => s.resetAvatar);

  const profile = getClusterProfileMeta(contextName);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [shape, setShape] = useState<AvatarShape>(
    existing?.kind === "character" ? existing.shape : "blob",
  );
  const [finish, setFinish] = useState<AvatarFinish>(
    existing?.kind === "character" ? existing.finish : "plush",
  );
  const [eyes, setEyes] = useState<AvatarEyes>(
    existing?.kind === "character" ? existing.eyes : "round",
  );
  const [color, setColor] = useState<string | "auto">(
    existing?.kind === "character" ? existing.color : "auto",
  );
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolvedColor = color === "auto" ? profile.autoCharacterColor : color;
  const isCharacterActive = existing?.kind === "character";

  const commitCharacter = (
    next: Partial<{
      shape: AvatarShape;
      finish: AvatarFinish;
      eyes: AvatarEyes;
      color: string | "auto";
    }>,
  ) => {
    const nextShape = next.shape ?? shape;
    const nextFinish = next.finish ?? finish;
    const nextEyes = next.eyes ?? eyes;
    const nextColor = next.color ?? color;
    setShape(nextShape);
    setFinish(nextFinish);
    setEyes(nextEyes);
    setColor(nextColor);
    const config: ClusterAvatarConfig = {
      kind: "character",
      shape: nextShape,
      finish: nextFinish,
      eyes: nextEyes,
      color: nextColor,
    };
    setAvatar(contextId, config);
  };

  const handleRandomize = () => {
    commitCharacter({
      shape: pickRandom(AVATAR_SHAPES).id,
      eyes: pickRandom(AVATAR_EYES).id,
      color: pickRandom(AVATAR_COLOR_SWATCHES),
      finish,
    });
  };

  const handleResetToShortName = () => {
    resetAvatar(contextId);
    setShape("blob");
    setFinish("plush");
    setEyes("round");
    setColor("auto");
    setUploadError(null);
  };

  const handleFileChange = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    if (!file.type.startsWith("image/")) {
      setUploadError("Please choose a PNG, JPEG, GIF, SVG, or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setUploadError("Image must be under 2 MB.");
      return;
    }
    try {
      const dataUrl = await readImageAsDataUrl(file);
      setAvatar(contextId, { kind: "image", dataUrl, animatedRing: false });
    } catch {
      setUploadError("Could not read that image file.");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Customize profile for ${profile.shortName}`}
      data-testid="cluster-avatar-editor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[360px] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top live animated preview floating cleanly above the card */}
        <div className="relative mb-3 flex flex-col items-center">
          <div className="relative">
            <ClusterAvatar
              contextName={contextName}
              config={existing}
              size="xl"
              animated
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-panel text-muted-foreground shadow"
            >
              <Pencil size={11} />
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className="max-w-[200px] truncate text-xs font-semibold text-foreground"
              title={contextName}
            >
              {profile.shortName}
            </span>
            <button
              type="button"
              data-testid="editor-toggle-pin"
              onClick={() => togglePin(contextId)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                pinned
                  ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/20"
                  : "border-border bg-panel text-muted-foreground hover:text-foreground"
              }`}
            >
              {pinned ? (
                <>
                  <PinOff size={10} aria-hidden="true" />
                  Pinned
                </>
              ) : (
                <>
                  <Pin size={10} aria-hidden="true" />
                  Pin
                </>
              )}
            </button>
          </div>
        </div>

        {/* Main Studio Card matching reference layout */}
        <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {/* IMAGE section */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Image
                </h3>
                <button
                  type="button"
                  aria-label="Close profile editor"
                  onClick={onClose}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
                >
                  <X size={13} />
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                data-testid="avatar-file-input"
                className="hidden"
                onChange={(e) => void handleFileChange(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-center gap-3 rounded-xl border border-border/80 bg-elevated/60 px-3.5 py-3 text-left transition-colors hover:border-border-strong hover:bg-hover/70"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background/70 text-muted-foreground ring-1 ring-border/70">
                  <Plus size={16} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-foreground">
                    {existing?.kind === "image" ? "Replace image" : "Upload image"}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    PNG, JPEG, GIF or WebP · square crop
                  </span>
                </span>
              </button>
              {uploadError ? (
                <p className="text-[11px] text-destructive" role="alert">
                  {uploadError}
                </p>
              ) : null}
            </section>

            {/* SHAPE section */}
            <section className="space-y-2.5 border-t border-border/70 pt-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Shape
                  </h3>
                  <div
                    role="group"
                    aria-label="Avatar finish"
                    className="inline-flex rounded-lg border border-border bg-background/70 p-0.5 text-[11px]"
                  >
                    {(["plush", "flat"] as const).map((mode) => {
                      const active = finish === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          data-testid={`avatar-finish-${mode}`}
                          aria-pressed={active}
                          onClick={() => commitCharacter({ finish: mode })}
                          className={`rounded-md px-2.5 py-0.5 font-medium capitalize transition-colors ${
                            active
                              ? "bg-elevated text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="avatar-reset-default"
                    title={`Reset to default short name (${profile.initials})`}
                    aria-label="Reset to short name"
                    onClick={handleResetToShortName}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-testid="avatar-randomize"
                    title="Randomize avatar"
                    aria-label="Randomize avatar"
                    onClick={handleRandomize}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                  >
                    <Shuffle size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-5 gap-1.5">
                {AVATAR_SHAPES.map((item) => {
                  const selected = isCharacterActive && shape === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`avatar-shape-${item.id}`}
                      aria-label={item.label}
                      aria-pressed={selected}
                      title={item.label}
                      onClick={() => commitCharacter({ shape: item.id })}
                      className={`flex aspect-square items-center justify-center rounded-xl p-1.5 transition-all ${
                        selected
                          ? "bg-elevated/70 ring-1 ring-foreground/65"
                          : "hover:bg-hover/70"
                      }`}
                    >
                      <span className="h-9 w-9">
                        <CharacterAvatarSvg
                          shape={item.id}
                          finish={finish}
                          eyes={eyes}
                          color={resolvedColor}
                          animated={false}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* EYES section */}
            <section className="space-y-2.5 border-t border-border/70 pt-3.5">
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Eyes
              </h3>
              <div className="grid grid-cols-4 gap-1.5">
                {AVATAR_EYES.map((item) => {
                  const selected = isCharacterActive && eyes === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`avatar-eyes-${item.id}`}
                      aria-label={item.label}
                      aria-pressed={selected}
                      title={item.label}
                      onClick={() => commitCharacter({ eyes: item.id })}
                      className={`flex aspect-[4/3] items-center justify-center rounded-xl p-1 transition-all ${
                        selected
                          ? "bg-elevated/70 ring-1 ring-foreground/65"
                          : "hover:bg-hover/70"
                      }`}
                    >
                      <span className="h-10 w-10">
                        <CharacterAvatarSvg
                          shape={shape}
                          finish={finish}
                          eyes={item.id}
                          color={resolvedColor}
                          animated={false}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* COLOR section */}
            <section className="space-y-2.5 border-t border-border/70 pt-3.5">
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Color
              </h3>
              <div className="grid grid-cols-9 gap-1.5">
                {/* Auto color ("A") */}
                <button
                  type="button"
                  data-testid="avatar-color-auto"
                  aria-label="Auto color"
                  aria-pressed={isCharacterActive && color === "auto"}
                  title="Auto color from cluster name"
                  onClick={() => commitCharacter({ color: "auto" })}
                  className={`flex h-7 w-7 items-center justify-center rounded-lg transition-all ${
                    isCharacterActive && color === "auto"
                      ? "bg-elevated ring-1 ring-foreground/70"
                      : "hover:bg-hover"
                  }`}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground text-[10px] font-semibold text-foreground">
                    A
                  </span>
                </button>

                {AVATAR_COLOR_SWATCHES.map((hex) => {
                  const selected = isCharacterActive && color === hex;
                  return (
                    <button
                      key={hex}
                      type="button"
                      data-testid={`avatar-color-${hex.slice(1)}`}
                      aria-label={`Color ${hex}`}
                      aria-pressed={selected}
                      onClick={() => commitCharacter({ color: hex })}
                      className={`flex h-7 w-7 items-center justify-center rounded-lg transition-transform hover:scale-105 ${
                        selected ? "ring-1 ring-foreground/80" : ""
                      }`}
                    >
                      <span
                        className="h-5 w-5 rounded-full shadow-inner"
                        style={{ backgroundColor: hex }}
                      />
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Subtle Footer */}
          <div className="flex items-center justify-between border-t border-border/80 bg-elevated/40 px-4 py-2">
            <button
              type="button"
              onClick={handleResetToShortName}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Default short name ({profile.initials})
            </button>
            <Button size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
