import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
};

export const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") {
		return [content];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}
	return textParts;
};

type RunMessage = { role?: string; content?: unknown; stopReason?: string };

export const collectRunText = (messages: RunMessage[]): string =>
	messages
		.filter((m) => m && m.role === "assistant" && m.stopReason !== "error")
		.flatMap((m) => extractTextParts(m.content))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n");

export const CODE_SKIPPED = "Code block skipped.";

const PATH_START = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|%[A-Za-z_]+%[\\/])/;
const BARE_PATH =
	/(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|%[A-Za-z_]+%[\\/])[^\s"'<>|)]*|(?<![\w/\\.-])(?!\d+[\\/]\d+[\\/]\d+)[\w.@%*-]+(?:[\\/][\w.@%*-]+){2,}[\\/]?|(?<![\w/\\.-])[\w.@*-]+[\\/][\w.@*-]*\.[A-Za-z][A-Za-z0-9]{0,5}(?![\w/\\])/g;

export const speakPath = (path: string): string => {
	const trimmed = path.replace(/[\\/]+$/, "").replace(/[.,;:]+$/, "");
	const name = trimmed.split(/[\\/]/).pop() || trimmed;
	return name.replace(/\*/g, "").replace(/\./g, " dot ").replace(/\s+/g, " ").trim();
};

const speakUrl = (url: string): string => {
	const host = url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/^www\./, "");
	return `link to ${host}`;
};

const speakInline = (code: string): string => {
	const text = code.trim();
	if (/^https?:\/\//i.test(text)) return speakUrl(text);
	if (PATH_START.test(text)) return speakPath(text);
	return text.replace(BARE_PATH, (m) => speakPath(m));
};

const speakTableRow = (line: string): string | null => {
	const cells = line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
	if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) return null;
	return `${cells.filter(Boolean).join(", ")}.`;
};

export const speakableText = (markdown: string): string => {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let fence: string | null = null;

	for (const rawLine of lines) {
		const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/);
		if (fence) {
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			out.push(CODE_SKIPPED);
			continue;
		}

		let line = rawLine;
		if (/^\s*\|.*\|\s*$/.test(line)) {
			const row = speakTableRow(line);
			if (row === null) continue;
			line = row;
		}
		if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue;

		const spans: string[] = [];
		const hold = (value: string): string => `\u0000${spans.push(value) - 1}\u0000`;

		line = line
			.replace(/`+([^`]+)`+/g, (_m, code) => hold(speakInline(code)))
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/<?(https?:\/\/[^\s>)]+)>?/gi, (_m, url) => hold(speakUrl(url)))
			.replace(BARE_PATH, (m) => hold(speakPath(m)))
			.replace(/^\s*(?:>\s*)+/, "")
			.replace(/^\s*#{1,6}\s+/, "")
			.replace(/^\s*-#\s+/, "")
			.replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
			.replace(/\*+|~~/g, "")
			.replace(/\s*(?:→|->|=>)\s*/g, " to ")
			.replace(/\u0000(\d+)\u0000/g, (_m, i) => spans[Number(i)])
			.replace(/_+/g, " ")
			.replace(/[ \t]+/g, " ")
			.trim();

		if (!line) continue;
		if (!/[.!?:;,]["')\]]?$/.test(line)) line += ".";
		out.push(line);
	}

	return out.join("\n");
};

const STATE_FILE = join(homedir(), ".pi", "agent", "extensions", ".read-aloud-state.json");
const LAST_DIR = join(homedir(), ".pi", "agent", "read-aloud", "last");
const PROMPT_DIR = join(homedir(), ".pi", "agent", "read-aloud", "prompt");
export const SPEAK_PROMPT_KEY = "alt+s";
const READER_SCRIPT = join(homedir(), "bin", "read-aloud.ps1");

const loadEnabled = (): boolean => {
	try {
		if (!existsSync(STATE_FILE)) return false;
		return JSON.parse(readFileSync(STATE_FILE, "utf8"))?.enabled === true;
	} catch {
		return false;
	}
};

const saveEnabled = (enabled: boolean): void => {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify({ enabled }), "utf8");
};

export const paneKey = (env: NodeJS.ProcessEnv, sessionId?: string): string =>
	(env.HC_TERMINAL_ID || env.HERDR_PANE_ID || `session-${sessionId || "unknown"}`).replace(/[^\w.-]/g, "_");

const canSpeak = (): boolean => process.platform === "win32";

const runReader = (args: string[], onError: (message: string) => void): void => {
	if (!canSpeak()) {
		onError("speech only works on Windows");
		return;
	}
	execFile(
		"powershell.exe",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", READER_SCRIPT, ...args],
		{ windowsHide: true },
		(error, _stdout, stderr) => {
			const detail = stderr.trim().split(/\r?\n/)[0] || error?.message;
			if (detail) onError(detail);
		},
	);
};

export default function readAloudExtension(pi: ExtensionAPI) {
	let runMessages: RunMessage[] = [];

	const lastFile = (ctx: any): string => {
		let sessionId: string | undefined;
		try {
			sessionId = ctx?.sessionManager?.getSessionId?.();
		} catch {
			sessionId = undefined;
		}
		return join(LAST_DIR, `${paneKey(process.env, sessionId)}.txt`);
	};

	const reporter = (ctx: any) => (message: string): void => {
		ctx.ui.notify(`Read-aloud failed: ${message}`, "error");
	};

	pi.registerCommand("speak", {
		description: "Toggle reading each full response aloud (all pi tabs)",
		handler: async (_args, ctx) => {
			const enabled = !loadEnabled();
			try {
				saveEnabled(enabled);
			} catch (error) {
				reporter(ctx)(error instanceof Error ? error.message : String(error));
				return;
			}
			ctx.ui.notify(enabled ? "Read-aloud on. Full responses, all tabs." : "Read-aloud off.", "info");
		},
	});

	pi.registerCommand("speak-last", {
		description: "Read this tab's last response aloud now",
		handler: async (_args, ctx) => {
			const file = lastFile(ctx);
			if (!existsSync(file)) {
				ctx.ui.notify("No saved response for this tab yet.", "warning");
				return;
			}
			runReader(["-File", file, "-Now"], reporter(ctx));
		},
	});

	let lastDraft = "";
	pi.events.on("editor:draft", (text) => {
		if (typeof text === "string") lastDraft = text;
	});

	const speakPrompt = (ctx: any, restore = false): void => {
		const boxText: string = ctx.ui.getEditorText() ?? "";
		const useDraft = !boxText.trim() || boxText.trimStart().startsWith("/");
		const source = useDraft ? lastDraft : boxText;
		const spoken = speakableText(source);
		if (!spoken) {
			ctx.ui.notify("Your input box is empty.", "warning");
			return;
		}
		if (restore && useDraft && !boxText.trim()) {
			ctx.ui.setEditorText(source);
			ctx.ui.notify("Your last prompt is back in the box. Reading it now.", "info");
		}
		const file = lastFile(ctx).replace(LAST_DIR, PROMPT_DIR);
		try {
			mkdirSync(PROMPT_DIR, { recursive: true });
			writeFileSync(file, spoken, "utf8");
		} catch (error) {
			reporter(ctx)(error instanceof Error ? error.message : String(error));
			return;
		}
		runReader(["-File", file, "-Now"], reporter(ctx));
	};

	pi.registerCommand("speak-prompt", {
		description: `Read your input box aloud (${SPEAK_PROMPT_KEY})`,
		handler: async (_args, ctx) => speakPrompt(ctx, true),
	});

	pi.registerShortcut(SPEAK_PROMPT_KEY, {
		description: "Read your input box aloud",
		handler: async (ctx) => speakPrompt(ctx),
	});

	pi.registerCommand("speak-stop", {
		description: "Stop reading aloud and clear the queue",
		handler: async (_args, ctx) => {
			runReader(["-Stop"], reporter(ctx));
		},
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role !== "assistant") return;
		runMessages.push(event.message as RunMessage);
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const messages = runMessages;
		runMessages = [];
		const spoken = speakableText(collectRunText(messages));
		if (!spoken) return;

		const file = lastFile(ctx);
		try {
			mkdirSync(LAST_DIR, { recursive: true });
			writeFileSync(file, spoken, "utf8");
		} catch (error) {
			reporter(ctx)(error instanceof Error ? error.message : String(error));
			return;
		}

		if ((event as { aborted?: boolean }).aborted) return;
		if (!loadEnabled()) return;
		runReader(["-File", file], reporter(ctx));
	});
}
