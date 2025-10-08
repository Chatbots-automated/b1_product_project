// Vercel Serverless Function (Node.js 18+)
const axios = require("axios");

// ---------- CONFIG (hardcode your key if you like) ----------
const B1_BASE_URL       = "https://www.b1.lt";
const B1_API_KEY        = "PASTE_YOUR_B1_API_KEY_HERE";
const B1_COMPANY_ID     = ""; // optional
const TARGET_GROUP_NAME = "xxx_pvz grupė";
const DEFAULT_DRY_RUN   = true;  // change to false to commit by default
// ------------------------------------------------------------

const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${B1_API_KEY}`,
  ...(B1_COMPANY_ID ? { "X-Company-Id": B1_COMPANY_ID } : {}),
};

const B1_PATHS = {
  itemsList:  "/api/reference-book/items/list",
  itemUpdate: "/api/reference-book/items/update",
  groupsList: "/api/reference-book/item-groups/list",
  groupCreate:"/api/reference-book/item-groups/create",
  groupDelete:"/api/reference-book/item-groups/delete",
};

const SEPS = /[_\-/()[\].,:;]+/g;
const baseWord = (s) => {
  if (!s) return "";
  s = String(s).trim().toLowerCase();
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const first = s.split(SEPS)[0] || s;
  return first.replace(/[^a-z0-9]+/g, " ").trim();
};

async function b1Post(path, payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { data } = await axios.post(B1_BASE_URL + path, payload, {
        headers: HEADERS,
        timeout: 60000,
      });
      return data;
    } catch (err) {
      const code = err?.response?.status;
      if ([429, 500, 502, 503, 504].includes(code) && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function groupsListByNameContains(q, page = 1, rows = 500) {
  const payload = {
    rows, page, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "name", op: "cn", data: q }] },
  };
  const res = await b1Post(B1_PATHS.groupsList, payload);
  return res?.rows || [];
}
async function listAllGroups() {
  let page = 1, out = [];
  for (;;) {
    const rows = await groupsListByNameContains("", page);
    if (!rows?.length) break;
    out = out.concat(rows);
    page++;
  }
  return out;
}
async function ensureGroupByExactName(name, cacheByName, DRY_RUN) {
  const key = name.trim().toLowerCase();
  if (cacheByName.has(key)) return cacheByName.get(key);

  const hits = await groupsListByNameContains(name);
  let grp = hits.find((g) => String(g.name || "").trim().toLowerCase() === key);
  if (grp) {
    cacheByName.set(key, grp);
    return grp;
  }
  if (DRY_RUN) return { id: -1, name };
  const created = await b1Post(B1_PATHS.groupCreate, { name });
  grp = { id: created.id, name };
  cacheByName.set(key, grp);
  return grp;
}
async function itemsListByGroupId(groupId, page = 1, rows = 500) {
  const payload = {
    rows, page, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "groupId", op: "eq", data: groupId }] },
  };
  const res = await b1Post(B1_PATHS.itemsList, payload);
  return res?.rows || [];
}
async function deleteGroupById(groupId, DRY_RUN) {
  if (DRY_RUN) return { dryRun: true };
  return b1Post(B1_PATHS.groupDelete, { id: groupId });
}
async function updateItem(itemId, fields, DRY_RUN) {
  if (DRY_RUN) return { dryRun: true };
  return b1Post(B1_PATHS.itemUpdate, { id: itemId, ...fields });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    // Expect: { items: [...], dryRun?: boolean, targetGroupName?: string }
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      res.status(400).json({ error: "Body must include { items: [ ... ] }" });
      return;
    }
    const DRY_RUN = body.dryRun ?? DEFAULT_DRY_RUN;
    const TARGET  = (body.targetGroupName || TARGET_GROUP_NAME).trim();

    // 1) ensure target group exists
    const allGroups = await listAllGroups();
    const groupCacheByName = new Map(
      allGroups.map((g) => [String(g.name || "").trim().toLowerCase(), g])
    );
    const targetGroup = await ensureGroupByExactName(TARGET, groupCacheByName, DRY_RUN);

    // 2) filter: Pavadinimas starts with 'xxx'
    const isXxx = (s) => String(s || "").trim().toLowerCase().startsWith("xxx");
    const candidates = items.filter((it) => isXxx(it["Pavadinimas"]));

    // 3) move + clear code (bulk, chunked + parallel)
    const touchedKeys = new Set(); // original group names + base words
    let moved = 0;

    const CHUNK = 200;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK);

      // collect touched keys
      for (const it of chunk) {
        const name = it["Pavadinimas"] || "";
        const orig = (it["Grupė"] || "").trim();
        if (orig) touchedKeys.add(orig);
        const bw = baseWord(name);
        if (bw) touchedKeys.add(bw);
      }

      // parallel updates (cap concurrency with Promise.allSettled on chunk)
      const tasks = [];
      for (const it of chunk) {
        const itemId = it["ID"];
        tasks.push(updateItem(itemId, { groupId: targetGroup.id }, DRY_RUN));
        tasks.push(updateItem(itemId, { code: "" }, DRY_RUN));
      }
      const results = await Promise.allSettled(tasks);
      const ok = results.filter(r => r.status === "fulfilled").length;
      moved += Math.floor(ok / 2); // two updates per item
    }

    // 4) try deleting emptied groups
    let groupsChecked = 0;
    let groupsDeleted = 0;

    for (const key of touchedKeys) {
      const hits = await groupsListByNameContains(key);
      if (!hits.length) continue;

      // check each matched group; skip the target group
      for (const g of hits) {
        const gName = String(g.name || "").trim();
        if (!gName || gName.toLowerCase() === TARGET.toLowerCase()) continue;

        const still = await itemsListByGroupId(g.id);
        groupsChecked++;
        if (!still.length) {
          await deleteGroupById(g.id, DRY_RUN);
          groupsDeleted++;
        }
      }
    }

    res.status(200).json({
      dryRun: !!DRY_RUN,
      targetGroup: TARGET,
      receivedItems: items.length,
      processedItems: candidates.length,
      actuallyMoved: moved,
      groupsChecked,
      groupsDeleted,
      note: DRY_RUN ? "Dry run - no writes performed" : "Committed",
    });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
};
