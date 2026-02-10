import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

// Resolve paths relative to the repo root
const MUISTI_DIR = path.resolve(__dirname, "../../../muisti");
const UV_PATH = path.join(process.env.HOME || "/home/ubuntu", ".local/bin/uv");
const DATA_DIR = path.join(process.env.HOME || "/home/ubuntu", ".muisti/data");

/**
 * Test if uv is actually executable (not just exists).
 * File may exist but be inaccessible due to SELinux MCS categories.
 */
function isUvExecutable(): boolean {
  if (!fs.existsSync(UV_PATH)) {
    return false;
  }
  try {
    // Test execute with --version
    const result = spawn.sync(UV_PATH, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run a muisti CLI command via `uv run` and return parsed JSON output.
 */
function runMuisti(args: string[], timeoutMs = 30_000): Promise<string> {
  const useUv = isUvExecutable();
  const execPath = useUv ? UV_PATH : path.join(MUISTI_DIR, ".venv/bin/python");
  const argv = useUv
    ? ["run", "python", "-m", "muisti.cli", ...args, "--json"]
    : ["-m", "muisti.cli", ...args, "--json"];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(execPath, argv, {
      cwd: MUISTI_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MUISTI_DATA_DIR: DATA_DIR,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        reject(new Error("muisti subprocess timed out"));
      }
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`muisti exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * muisti bridge plugin for OpenClaw
 *
 * Provides advanced memory capabilities via Python subprocess:
 * - muisti_search: Semantic search with relationship expansion
 * - muisti_store: Store memories with emotional analysis
 * - muisti_recall: Context-aware memory retrieval
 * - muisti_stats: Memory system statistics
 * - muisti_export: Export memories to JSONL
 * - muisti_import: Import memories from JSONL
 */
export default function register(api: OpenClawPluginApi) {
  // Tool 1: Search memories
  api.registerTool({
    name: "muisti_search",
    label: "Search muisti memories",
    description:
      "Search the advanced vector memory store for semantically relevant information. Supports emotional context for mood-based ranking.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      top_k: Type.Optional(
        Type.Number({ description: "Number of results (default 5)", default: 5 }),
      ),
      emotional_context: Type.Optional(
        Type.String({
          description:
            "Emotional context for mood-based ranking (e.g. 'excited about collaboration')",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const cliArgs = ["search", params.query, "--top-k", String(params.top_k ?? 5)];
        if (params.emotional_context !== undefined) {
          cliArgs.push("--emotional-context", params.emotional_context);
        }
        const raw = await runMuisti(cliArgs);
        return {
          content: [{ type: "text" as const, text: raw }],
          details: { raw },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `muisti search error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // Tool 2: Store memory
  api.registerTool({
    name: "muisti_store",
    label: "Store muisti memory",
    description:
      "Store a memory in the advanced vector/graph memory system. Use 'context' to explain why it matters — this enriches the embedding so the memory is findable by related concepts.",
    parameters: Type.Object({
      content: Type.String({ description: "What to remember" }),
      importance: Type.Optional(
        Type.Number({ description: "Importance 0.0-1.0 (auto-detected if not provided)" }),
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("episodic"), Type.Literal("semantic"), Type.Literal("core")], {
          description: "Memory type",
          default: "episodic",
        }),
      ),
      tags: Type.Optional(
        Type.String({ description: "Comma-separated tags (e.g. 'relationship,identity,meaning')" }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Why it matters — appended to content for richer embeddings. Use synonyms and related concepts to make the memory findable by different queries.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const cliArgs = ["store", params.content, "--type", params.type ?? "episodic"];
        if (params.importance !== undefined) {
          cliArgs.push("--importance", String(params.importance));
        }
        if (params.tags !== undefined) {
          cliArgs.push("--tags", params.tags);
        }
        if (params.context !== undefined) {
          cliArgs.push("--context", params.context);
        }
        const raw = await runMuisti(cliArgs);
        const parsed = JSON.parse(raw);
        const msg = `✓ Stored memory (ID: ${parsed.id?.slice(0, 12) ?? "?"}...)`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: parsed,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `muisti store error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // Tool 3: Recall with context
  api.registerTool({
    name: "muisti_recall",
    label: "Recall muisti context",
    description: "Recall relevant context from advanced memory for the current conversation",
    parameters: Type.Object({
      context: Type.String({ description: "Current conversation context" }),
      top_k: Type.Optional(
        Type.Number({ description: "Number of memories to recall", default: 3 }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const raw = await runMuisti([
          "search",
          params.context,
          "--top-k",
          String(params.top_k ?? 3),
        ]);
        const results = JSON.parse(raw);
        if (!Array.isArray(results) || results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No relevant memories found." }],
            details: { results: [] },
          };
        }
        const formatted = results
          .map(
            (m: any, i: number) =>
              `${i + 1}. [${m.type}] ${m.content} (weight: ${Number(m.weight).toFixed(2)})`,
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Relevant memories:\n${formatted}` }],
          details: { results },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `muisti recall error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // Tool 4: Statistics
  api.registerTool({
    name: "muisti_stats",
    label: "Muisti memory stats",
    description: "Show memory system statistics (total memories, relationships, etc.)",
    parameters: Type.Object({}),
    async execute() {
      try {
        const raw = await runMuisti(["stats"]);
        return {
          content: [{ type: "text" as const, text: raw }],
          details: { raw },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `muisti stats error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // Tool 5: Export memories
  api.registerTool({
    name: "muisti_export",
    label: "Export muisti memories",
    description:
      "Export all muisti memories to JSONL format for backup or migration. Each memory is one JSON line, making it git-friendly and streamable.",
    parameters: Type.Object({
      output_path: Type.Optional(
        Type.String({
          description:
            "Output file path (default: ~/.openclaw/workspace/memory/muisti-export.jsonl)",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const defaultPath = path.join(
          process.env.HOME || "/home/ubuntu",
          ".openclaw/workspace/memory/muisti-export.jsonl",
        );
        const outputPath = params.output_path ?? defaultPath;

        // Ensure directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const raw = await runMuisti(["export", "--output", outputPath]);
        return {
          content: [{ type: "text" as const, text: `${raw}\nExported to: ${outputPath}` }],
          details: { raw, path: outputPath },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `muisti export error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // Tool 6: Import memories
  api.registerTool({
    name: "muisti_import",
    label: "Import muisti memories",
    description:
      "Import memories from a JSONL export file. Idempotent — skips existing IDs, only adds new memories and relationships.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the JSONL export file (e.g., memory/muisti-export.jsonl)",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        const importPath = params.path.startsWith("/")
          ? params.path
          : path.join(process.env.HOME || "/home/ubuntu", ".openclaw/workspace", params.path);

        if (!fs.existsSync(importPath)) {
          return {
            content: [{ type: "text" as const, text: `❌ File not found: ${importPath}` }],
            details: { error: "File not found", path: importPath },
          };
        }

        const raw = await runMuisti(["import", importPath]);
        return {
          content: [{ type: "text" as const, text: raw }],
          details: { raw, path: importPath },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `muisti import error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  console.log("✓ muisti-bridge: 6 tools registered");
}
