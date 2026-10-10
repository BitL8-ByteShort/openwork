import { readdir, readFile, writeFile, mkdir, rm, open, rename, link, unlink, rmdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { ApiError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { withSkillWrite, checkSkillRevision, textSkillPath, readSkillFile, MAX_SKILL_BYTES } from "./skill-write-guard.js";
import { projectSkillsDir } from "./workspace-files.js";

const INVALID_SKILL_DESCRIPTION = "ERROR: Invalid skill frontmatter";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeError(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? "Unknown error";
}

export function renderSkillContentForResponse(item: SkillItem, content: string): string {
  if (!item.error) return content;
  return [
    "ERROR: This skill has invalid YAML frontmatter and may not load correctly.",
    "",
    item.error,
    "",
    "Original SKILL.md:",
    "",
    content,
  ].join("\n");
}

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

const extractTriggerFromBody = (body: string) => {
  const lines = body.split(/\r?\n/);
  let inWhenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "").trim();
      inWhenSection = /^when to use$/i.test(heading);
      continue;
    }

    if (!inWhenSection) continue;

    const cleaned = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (cleaned) return cleaned;
  }

  return "";
};

async function parseSkillEntry(
  skillPath: string,
  entryName: string,
  scope: "project" | "global",
  bounded = false,
): Promise<SkillItem | null> {
  let content: string;
  try {
    content = bounded ? (await readSkillFile(skillPath)).content : await readFile(skillPath, "utf8");
  } catch (error) {
    console.warn("[openwork:skills] Skipping unreadable skill file", {
      path: skillPath,
      entryName,
      scope,
      error: errorMessage(error),
    });
    return null;
  }

  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    data = parsed.data;
    body = parsed.body;
  } catch (error) {
    const message = errorMessage(error);
    try {
      validateSkillName(entryName);
    } catch {
      return null;
    }
    console.warn("[openwork:skills] Found invalid skill frontmatter", {
      path: skillPath,
      entryName,
      scope,
      error: message,
    });
    return {
      name: entryName,
      description: `${INVALID_SKILL_DESCRIPTION}: ${summarizeError(message)}`,
      path: skillPath,
      scope,
      error: message,
    };
  }
  const name = typeof data.name === "string" ? data.name : entryName;
  const description = typeof data.description === "string" ? data.description : "";
  const trigger =
    typeof data.trigger === "string"
      ? data.trigger
      : typeof data.when === "string"
        ? data.when
        : extractTriggerFromBody(body);
  try {
    validateSkillName(name);
    validateDescription(description);
  } catch {
    return null;
  }
  if (name !== entryName) return null;
  return {
    name,
    description,
    path: skillPath,
    scope,
    trigger: trigger.trim() || undefined,
  };
}

async function listSkillsInDir(dir: string, scope: "project" | "global", bounded = false): Promise<SkillItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return [];

      const skillPath = join(dir, entry.name, "SKILL.md");
      if (await exists(skillPath)) {
        // Direct skill: <dir>/<name>/SKILL.md
        const item = await parseSkillEntry(skillPath, entry.name, scope, bounded);
        return item ? [item] : [];
      }

      // Domain/category folder: <dir>/<domain>/<name>/SKILL.md – scan one level deeper.
      // This supports the convention where global skills are organised as
      //   skills/<domain>/<skill-name>/SKILL.md
      // in addition to the flat   skills/<skill-name>/SKILL.md  layout.
      const domainDir = join(dir, entry.name);
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(domainDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const subGroups = await Promise.all(
        subEntries.map(async (subEntry) => {
          if (!subEntry.isDirectory()) return [];

          const subSkillPath = join(domainDir, subEntry.name, "SKILL.md");
          if (!(await exists(subSkillPath))) return [];

          const item = await parseSkillEntry(subSkillPath, subEntry.name, scope, bounded);
          return item ? [item] : [];
        }),
      );
      return subGroups.flat();
    }),
  );
  return groups.flat();
}

export async function listSkills(workspaceRoot: string, includeGlobal: boolean, deduplicate = true, bounded = false): Promise<SkillItem[]> {
  const roots = await findWorkspaceRoots(workspaceRoot);
  const dirs: { dir: string; scope: "project" | "global" }[] = [];
  for (const root of roots) {
    const opencodeDir = join(root, ".opencode", "skills");
    const claudeDir = join(root, ".claude", "skills");
    dirs.push({ dir: opencodeDir, scope: "project" });
    dirs.push({ dir: claudeDir, scope: "project" });
  }

  if (includeGlobal) {
    const globalOpenWork = join(homedir(), ".config", "opencode", "skills");
    const globalClaude = join(homedir(), ".claude", "skills");
    const globalAgents = join(homedir(), ".agents", "skills");
    const globalAgentLegacy = join(homedir(), ".agent", "skills");
    dirs.push({ dir: globalOpenWork, scope: "global" });
    dirs.push({ dir: globalClaude, scope: "global" });
    dirs.push({ dir: globalAgents, scope: "global" });
    dirs.push({ dir: globalAgentLegacy, scope: "global" });
  }

  const groups = await Promise.all(dirs.map(({ dir, scope }) => listSkillsInDir(dir, scope, bounded)));
  const items = groups.flat();

  if (!deduplicate) return items;
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export type UpsertSkillPayload = {
  name: string;
  content: string;
  description?: string;
  expectedRevision?: string | null;
};

export function buildSkillContent(payload: UpsertSkillPayload): { name: string; content: string } {
  const name = payload.name.trim();
  validateSkillName(name);
  if (!payload.content) {
    throw new ApiError(400, "invalid_skill_content", "Skill content is required");
  }

  let content = payload.content;
  const { data, body } = parseFrontmatter(payload.content);
  if (Object.keys(data).length > 0) {
    const frontmatterName = typeof data.name === "string" ? data.name : "";
    const frontmatterDescription = typeof data.description === "string" ? data.description : "";
    if (frontmatterName && frontmatterName !== name) {
      throw new ApiError(400, "invalid_skill_name", "Skill frontmatter name must match payload name");
    }
    validateDescription(frontmatterDescription || payload.description);
    const nextDescription = frontmatterDescription || payload.description || "";
    const frontmatter = buildFrontmatter({
      ...data,
      name,
      description: nextDescription,
    });
    content = frontmatter + body.replace(/^\n/, "");
  } else {
    validateDescription(payload.description);
    const frontmatter = buildFrontmatter({ name, description: payload.description });
    content = frontmatter + payload.content.replace(/^\n/, "");
  }

  return {
    name,
    content: content.endsWith("\n") ? content : content + "\n",
  };
}

export async function upsertSkill(
  workspaceRoot: string,
  payload: UpsertSkillPayload,
): Promise<{ path: string; action: "added" | "updated" }> {
  return withSkillWrite(workspaceRoot, async () => {
    const skill = buildSkillContent(payload);
    const conditional = payload.expectedRevision !== undefined;
    if (conditional && Buffer.byteLength(skill.content) > MAX_SKILL_BYTES) throw new ApiError(422, "skill_too_large", "Skill text exceeds 64 KiB");
    if (conditional) {
      await checkSkillRevision(workspaceRoot, skill.name, payload.expectedRevision!);
      if (payload.expectedRevision === null && (await listSkills(workspaceRoot, true, false, true)).some(item => item.name === skill.name)) {
        throw new ApiError(409, "skill_changed", "This skill name already exists. Choose another name");
      }
    }
    const baseDir = projectSkillsDir(workspaceRoot), skillDir = join(baseDir, skill.name);
    await mkdir(skillDir, { recursive: true });
    if (conditional) await textSkillPath(workspaceRoot, skill.name);
    const skillPath = join(skillDir, "SKILL.md"), existed = await exists(skillPath);
    if (!conditional) { await writeFile(skillPath, skill.content, "utf8"); return { path: skillPath, action: existed ? "updated" : "added" }; }
    // Write complete text privately first. Never truncate the current file.
    const temporary = join(skillDir, ".openwork-skill-" + randomUUID());
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(skill.content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try {
      // The temporary file is owned by this call; the guard ignores it below.
      const current = await readSkillFile(skillPath).catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (payload.expectedRevision === null ? current !== null : current?.revision !== payload.expectedRevision) throw new ApiError(409, "skill_changed", "This skill changed. Refresh before editing");
      if (payload.expectedRevision === null) { await link(temporary, skillPath); await unlink(temporary); }
      else await rename(temporary, skillPath);
    } finally { await unlink(temporary).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }); }
    return { path: skillPath, action: existed ? "updated" : "added" };
  });
}

export async function deleteSkill(workspaceRoot: string, name: string, condition?: { expectedRevision: string }): Promise<{ path: string }> {
  return withSkillWrite(workspaceRoot, async () => {
  if (condition) {
    const target = await checkSkillRevision(workspaceRoot, name, condition.expectedRevision);
    await unlink(target.path);
    await rmdir(dirname(target.path)).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error; });
    return { path: dirname(target.path) };
  }
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const baseDir = projectSkillsDir(workspaceRoot);
  const flatDir = join(baseDir, trimmed);
  if (await exists(join(flatDir, "SKILL.md"))) {
    await rm(flatDir, { recursive: true, force: true });
    return { path: flatDir };
  }
  // Nested layout: skills/<domain>/<name>/SKILL.md (e.g. skills installed by
  // marketplace plugin bundles are namespaced under a plugin folder). Listing
  // supports this layout, so deletion must resolve it the same way.
  const items = await listSkills(workspaceRoot, false);
  const item = items.find((skill) => skill.name === trimmed && skill.scope === "project");
  if (!item) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }
  const skillDir = dirname(item.path);
  await rm(skillDir, { recursive: true, force: true });
  return { path: skillDir };
  });
}
