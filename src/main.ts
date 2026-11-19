import "@logseq/libs";
import { dot, embed, ensureModel } from "./embedder";
import * as store from "./store";
import type { VecRecord } from "./store";

// ---------- settings ----------

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

logseq.useSettingsSchema([
  {
    key: "numResults",
    type: "number",
    default: 10,
    title: "Number of related notes",
    description: "How many related pages to show in the panel.",
  },
  {
    key: "modelId",
    type: "string",
    default: DEFAULT_MODEL,
    title: "Embedding model",
    description:
      "Hugging Face model id with ONNX weights (feature-extraction). Changing it triggers a full re-index.",
  },
  {
    key: "excludeJournals",
    type: "boolean",
    default: true,
    title: "Ignore journal pages",
    description: "Skip daily journal pages when indexing and when listing results.",
  },
  {
    key: "maxChars",
    type: "number",
    default: 2000,
    title: "Max characters per page",
    description: "Only the start of each page is embedded; small models read ~256 tokens anyway.",
  },
  {
    key: "panelWidth",
    type: "number",
    default: 340,
    title: "Panel width (px)",
    description: "Width of the docked panel.",
  },
]);

const cfg = () => {
  const s = (logseq.settings ?? {}) as Record<string, unknown>;
  return {
    n: Math.max(1, Number(s.numResults) || 10),
    modelId: String(s.modelId || DEFAULT_MODEL),
    excludeJournals: s.excludeJournals !== false,
    maxChars: Math.max(200, Number(s.maxChars) || 2000),
    width: Math.max(220, Number(s.panelWidth) || 340),
  };
};

// ---------- panel DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const listEl = () => $<HTMLUListElement>("list");

function setStatus(msg: string) {
  $("status").textContent = msg;
}

function setBar(frac: number | null) {
  const bar = $("bar");
  if (frac === null) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "block";
  (bar.firstElementChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
}

// ---------- insert link at cursor ----------

// Clicking in the panel can pull focus out of the editor, so remember the block and cursor
// position that were active when the mouse moved over the panel.
let lastEdit: { uuid: string; pos?: number } | null = null;

async function captureEditState() {
  try {
    const uuid = await logseq.Editor.checkEditing();
    if (!uuid || typeof uuid !== "string") return;
    const cur = await logseq.Editor.getEditingCursorPosition();
    lastEdit = { uuid, pos: cur?.pos };
  } catch {
    // keep whatever we captured before
  }
}

function flashStatus(msg: string, ms = 2500) {
  const el = $("status");
  const prev = el.textContent ?? "";
  setStatus(msg);
  window.setTimeout(() => {
    if (el.textContent === msg) setStatus(prev);
  }, ms);
}

async function insertLink(title: string) {
  const text = `[[${title}]]`;
  try {
    // Still in edit mode: the textarea keeps its caret after losing focus, so insert right there.
    if (await logseq.Editor.checkEditing()) {
      await logseq.Editor.insertAtEditingCursor(text);
      flashStatus(`Inserted ${text}`);
      return;
    }
    // Edit mode was dropped: re-enter the last block at the remembered position, then insert.
    if (lastEdit) {
      await logseq.Editor.editBlock(
        lastEdit.uuid,
        lastEdit.pos === undefined ? undefined : { pos: lastEdit.pos },
      );
      await new Promise((r) => setTimeout(r, 60));
      await logseq.Editor.insertAtEditingCursor(text);
      flashStatus(`Inserted ${text}`);
      return;
    }
    flashStatus("Place the cursor in a block first, then double-click a note to insert it.", 4000);
  } catch (e) {
    console.warn("related-notes: insert failed", e);
    flashStatus(`Could not insert: ${(e as Error).message}`, 4000);
  }
}

// ---------- results list ----------

// A plain click opens the page, but a double-click must not navigate away first, so the open
// is held back for this long to see whether a second click on the same item follows.
const DOUBLE_CLICK_MS = 250;
let pendingClick: { title: string; timer: number } | null = null;

function cancelPendingClick() {
  if (pendingClick) window.clearTimeout(pendingClick.timer);
  pendingClick = null;
}

function renderResults(items: { title: string; score: number }[], emptyMsg: string) {
  const ul = listEl();
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement("div");
    li.className = "empty";
    li.textContent = emptyMsg;
    ul.append(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.title = "Click to open · Shift-click to open in sidebar · Double-click to insert link at cursor";
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = it.title;
    const sc = document.createElement("span");
    sc.className = "score";
    sc.textContent = `${Math.round(it.score * 100)}%`;
    li.append(t, sc);
    li.addEventListener("click", async (e) => {
      if (e.shiftKey) {
        cancelPendingClick();
        if (e.detail > 1) return; // second click of a shift-double-click
        const page = await logseq.Editor.getPage(it.title);
        if (page?.uuid) logseq.Editor.openInRightSidebar(page.uuid);
        return;
      }
      // Second click on the same item within the window: insert instead of opening.
      if (pendingClick && pendingClick.title === it.title) {
        cancelPendingClick();
        void insertLink(it.title);
        return;
      }
      cancelPendingClick();
      pendingClick = {
        title: it.title,
        timer: window.setTimeout(() => {
          pendingClick = null;
          logseq.App.pushState("page", { name: it.title });
        }, DOUBLE_CLICK_MS),
      };
    });
    ul.append(li);
  }
}

// ---------- db-worker readiness ----------

// On DB graphs, API calls throw "db-worker has not been initialized" until Logseq's worker is up
// (startup, graph switch). Retry those with backoff instead of failing the whole index run.
const isWorkerNotReady = (e: unknown) => /db-worker|not been initialized/i.test(String((e as Error)?.message ?? e));

async function retryDb<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isWorkerNotReady(e) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 5000);
    }
  }
}

// ---------- text extraction ----------

type Block = { content?: string; title?: string; children?: unknown[] };

function flatten(blocks: Block[] | undefined, out: string[]) {
  for (const b of blocks ?? []) {
    // File graphs expose block text as `content`; DB graphs may use `title`.
    const text = b.content ?? b.title;
    if (text) out.push(text);
    if (b.children?.length) flatten(b.children as Block[], out);
  }
}

function clean(raw: string): string {
  return raw
    .split("\n")
    // Drop property lines (`key:: value`), including keys with spaces, dots or non-ASCII letters.
    .filter((l) => !/^\s*[^\s:][^:\n]*::(\s|$)/.test(l))
    .join("\n")
    .replace(/#\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^\s*(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function pageText(title: string, ref: string = title): Promise<string> {
  const tree = (await retryDb(() => logseq.Editor.getPageBlocksTree(ref))) as unknown as Block[];
  const parts: string[] = [];
  flatten(tree, parts);
  const body = clean(parts.join("\n"));
  if (!body) return "";
  return `${title}\n${body}`.slice(0, cfg().maxChars);
}

// Debug aid: show the raw block texts Logseq returned and the final text that gets embedded.
async function showIndexedText() {
  const title = await currentPageTitle();
  if (!title) return;
  const tree = (await retryDb(() => logseq.Editor.getPageBlocksTree(title))) as unknown as Block[];
  const raw: string[] = [];
  flatten(tree, raw);
  const final = await pageText(title);
  console.log("related-notes: raw blocks", tree);
  const ul = listEl();
  ul.replaceChildren();
  const li = document.createElement("li");
  li.style.display = "block";
  li.style.cursor = "default";
  const pre = document.createElement("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.wordBreak = "break-word";
  pre.style.margin = "0";
  pre.style.fontSize = "11px";
  pre.textContent =
    `EMBEDDED TEXT (${final.length} chars)\n${final}\n\n` +
    `RAW BLOCKS (${raw.length})\n` +
    raw.map((r, i) => `[${i}] ${r}`).join("\n");
  li.append(pre);
  ul.append(li);
  setStatus(`Showing indexed text for “${title}” — navigate to return to results`);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ":" + s.length;
}

// ---------- index ----------

const vectors = new Map<string, VecRecord>(); // key: lower-cased page name
let indexing = false;
let modelReady = false;

async function loadModel() {
  const { modelId } = cfg();
  setStatus(`Loading model ${modelId}…`);
  setBar(0);
  const files = new Map<string, number>();
  await ensureModel(modelId, (info) => {
    if (info.status === "progress" && info.file && typeof info.progress === "number") {
      files.set(info.file, info.progress);
      const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size / 100;
      setBar(avg);
      setStatus(`Downloading model… ${Math.round(avg * 100)}%`);
    }
  });
  setBar(null);
  modelReady = true;
}

async function upsertPage(
  title: string,
  ref: string = title,
  key = title.toLowerCase(),
): Promise<VecRecord | null> {
  const { modelId } = cfg();
  const text = await pageText(title, ref);
  if (text.length < 20) {
    if (vectors.delete(key)) await store.del(key);
    return null;
  }
  const hash = fnv1a(text);
  const old = vectors.get(key);
  if (old && old.hash === hash && old.model === modelId) return old;
  const rec: VecRecord = { name: key, title, hash, model: modelId, vec: await embed(text) };
  vectors.set(key, rec);
  await store.put(rec);
  return rec;
}

type PageLike = {
  name?: string;
  originalName?: string;
  title?: string;
  uuid?: string;
  journalDay?: number;
  ["journal?"]?: boolean;
};

// DB graphs may not set `originalName`, so fall back to `title` / `name`.
const pageTitle = (p: PageLike) => p.originalName ?? p.title ?? p.name ?? "";
const isJournal = (p: PageLike) => Boolean(p["journal?"] ?? p.journalDay);

async function indexAll(force = false) {
  if (indexing) return;
  indexing = true;
  try {
    if (!modelReady) await loadModel();
    const { modelId, excludeJournals } = cfg();
    if (force) {
      vectors.clear();
      await store.clear();
    }
    const all = ((await retryDb(() => logseq.Editor.getAllPages())) ?? []) as PageLike[];
    const pages = all.filter((p) => pageTitle(p) && !(excludeJournals && isJournal(p)));
    console.log(
      `related-notes: getAllPages returned ${all.length}, ${pages.length} after filtering`,
      all[0],
    );
    const live = new Set(pages.map((p) => pageTitle(p).toLowerCase()));
    for (const k of [...vectors.keys()]) {
      if (!live.has(k)) {
        vectors.delete(k);
        await store.del(k);
      }
    }
    let i = 0;
    for (const p of pages) {
      i++;
      if (i % 5 === 0 || i === pages.length) {
        setStatus(`Indexing ${i}/${pages.length}…`);
        setBar(i / pages.length);
      }
      try {
        await upsertPage(pageTitle(p), p.uuid ?? pageTitle(p));
      } catch (e) {
        console.warn("related-notes: failed to index", pageTitle(p), e);
      }
    }
    setBar(null);
    setStatus(
      `${vectors.size} pages indexed (of ${pages.length} candidates, ${all.length} total) · ${modelId}`,
    );
  } catch (e) {
    setBar(null);
    setStatus(`Error: ${(e as Error).message}`);
    console.error(e);
  } finally {
    indexing = false;
  }
}

// ---------- related lookup ----------

let currentTitle: string | null = null;

async function currentPageTitle(): Promise<string | null> {
  const cur = (await retryDb(() => logseq.Editor.getCurrentPage())) as
    | (PageLike & { page?: { id: number } })
    | null;
  if (!cur) return null;
  if (pageTitle(cur)) return pageTitle(cur);
  if (cur.page?.id) {
    const p = (await retryDb(() => logseq.Editor.getPage(cur.page!.id))) as PageLike | null;
    return p ? pageTitle(p) || null : null;
  }
  return null;
}

// ---------- semantic search ----------

let query = "";
let searchSeq = 0; // drops results from searches that were superseded while embedding

// BGE models are trained to retrieve passages for short queries given this instruction prefix.
function queryText(q: string): string {
  return /bge/i.test(cfg().modelId) ? `Represent this sentence for searching relevant passages: ${q}` : q;
}

async function runSearch(q: string) {
  const seq = ++searchSeq;
  $("heading").textContent = "Search results";
  if (!modelReady) {
    renderResults([], "Model is still loading…");
    return;
  }
  if (!vectors.size) {
    renderResults([], "No pages indexed yet.");
    return;
  }
  let qv: Float32Array;
  try {
    qv = await embed(queryText(q));
  } catch (e) {
    setStatus(`Error: ${(e as Error).message}`);
    return;
  }
  if (seq !== searchSeq) return;
  const scored: { title: string; score: number }[] = [];
  for (const r of vectors.values()) scored.push({ title: r.title, score: dot(qv, r.vec) });
  scored.sort((a, b) => b.score - a.score);
  renderResults(scored.slice(0, cfg().n), "No matches.");
}

async function refresh() {
  if (query) return runSearch(query);
  $("heading").textContent = "Related notes";
  if (!modelReady) return;
  const title = await currentPageTitle();
  if (!title) {
    renderResults([], "Open a page to see related notes.");
    return;
  }
  currentTitle = title;
  const { n, excludeJournals } = cfg();
  let rec: VecRecord | null = null;
  try {
    rec = await upsertPage(title);
  } catch (e) {
    setStatus(`Error: ${(e as Error).message}`);
    return;
  }
  if (!rec) {
    renderResults([], "This page has too little text to compare yet.");
    return;
  }
  const self = title.toLowerCase();
  const scored: { title: string; score: number }[] = [];
  for (const [k, r] of vectors) {
    if (k === self) continue;
    scored.push({ title: r.title, score: dot(rec.vec, r.vec) });
  }
  void excludeJournals; // journals are already filtered out at index time
  scored.sort((a, b) => b.score - a.score);
  renderResults(scored.slice(0, n), "No other indexed pages yet.");
}

let debounce: number | undefined;
function scheduleRefresh(ms = 1500) {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void refresh(), ms);
}

// ---------- panel visibility ----------

function applyPanelStyle() {
  const { width } = cfg();
  logseq.setMainUIInlineStyle({
    position: "fixed",
    top: "52px",
    right: "12px",
    bottom: "12px",
    width: `${width}px`,
    height: "auto",
    zIndex: "11",
    boxShadow: "0 6px 24px rgba(0,0,0,.18)",
    borderRadius: "10px",
  });
}

let visible = false;
function showPanel() {
  applyPanelStyle();
  logseq.showMainUI({ autoFocus: false });
  visible = true;
  logseq.updateSettings({ panelOpen: true });
  scheduleRefresh(0);
}
function hidePanel() {
  logseq.hideMainUI({ restoreEditingCursor: true });
  visible = false;
  logseq.updateSettings({ panelOpen: false });
}
const togglePanel = () => (visible ? hidePanel() : showPanel());

// ---------- boot ----------

async function main() {
  $("close").addEventListener("click", hidePanel);
  $("reindex").addEventListener("click", () => void indexAll(false));
  // Snapshot the editing block + caret while the editor still has focus, before the click lands.
  $("panel").addEventListener("pointerenter", () => void captureEditState());

  const qInput = $<HTMLInputElement>("q");
  let qTimer: number | undefined;
  qInput.addEventListener("input", () => {
    query = qInput.value.trim();
    window.clearTimeout(qTimer);
    qTimer = window.setTimeout(() => void refresh(), 300);
  });
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      qInput.value = "";
      query = "";
      void refresh();
    }
  });

  const setTheme = (mode: string) => {
    document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
  };
  const configs = await logseq.App.getUserConfigs();
  setTheme(configs?.preferredThemeMode ?? "light");
  logseq.App.onThemeModeChanged(({ mode }) => setTheme(mode));

  logseq.provideModel({ toggle: togglePanel });
  logseq.App.registerUIItem("toolbar", {
    key: "related-notes-toggle",
    template: `<a class="button" data-on-click="toggle" title="Related notes"><i class="ti ti-share"></i></a>`,
  });
  logseq.App.registerCommandPalette(
    { key: "related-notes-toggle", label: "Related notes: toggle panel" },
    togglePanel,
  );
  logseq.App.registerCommandPalette(
    { key: "related-notes-reindex", label: "Related notes: re-index changed pages" },
    () => void indexAll(false),
  );
  logseq.App.registerCommandPalette(
    { key: "related-notes-reindex-all", label: "Related notes: rebuild index from scratch" },
    () => void indexAll(true),
  );

  logseq.App.registerCommandPalette(
    { key: "related-notes-show-text", label: "Related notes: show indexed text of current page" },
    () => {
      if (!visible) showPanel();
      void showIndexedText();
    },
  );

  // Navigating away: refresh the page we left (it may have been edited), then show the new one.
  logseq.App.onRouteChanged(async () => {
    lastEdit = null; // the remembered block belongs to the page we just left
    cancelPendingClick();
    const left = currentTitle;
    if (left && modelReady) upsertPage(left).catch(() => undefined);
    scheduleRefresh(300);
  });
  // Switching graphs restarts the db-worker; re-sync the index once it is back.
  logseq.App.onCurrentGraphChanged(() => {
    void indexAll(false).then(refresh);
  });
  // Typing on the current page: re-embed after a short pause.
  logseq.DB.onChanged(() => {
    if (visible) scheduleRefresh(2500);
  });
  logseq.onSettingsChanged((now, old) => {
    if (now.modelId !== old.modelId) {
      modelReady = false;
      void indexAll(true).then(refresh);
    } else if (now.maxChars !== old.maxChars || now.excludeJournals !== old.excludeJournals) {
      void indexAll(true).then(refresh);
    } else {
      if (visible) applyPanelStyle();
      scheduleRefresh(0);
    }
  });

  // Warm start from the cached vectors, then catch up on anything that changed.
  const { modelId } = cfg();
  for (const r of await store.getAll()) if (r.model === modelId) vectors.set(r.name, r);

  if ((logseq.settings as Record<string, unknown> | undefined)?.panelOpen) showPanel();
  await indexAll(false);
  await refresh();
}

logseq.ready(main).catch(console.error);
