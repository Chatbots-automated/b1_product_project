// Vercel Serverless Function (Node.js 18+)
const axios = require("axios");

// ---------- CONFIG ----------
const B1_BASE_URL       = "https://www.b1.lt";
const B1_API_KEY        = "YOUR_KEY_HERE";
const B1_COMPANY_ID     = ""; // e.g. "123" if required
const TARGET_GROUP_NAME = "xxx_pvz grupė";
const DEFAULT_DRY_RUN   = false;
// ------------------------------------------------------------

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "B1-Api-Key": B1_API_KEY,                   // ✅ correct header
  ...(B1_COMPANY_ID ? { "X-Company-Id": B1_COMPANY_ID } : {}),
};

function withAuth(payload = {}) {
  const p = { ...payload, apiKey: B1_API_KEY }; // also put apiKey in body (some endpoints require)
  if (B1_COMPANY_ID) p.companyId = B1_COMPANY_ID;
  return p;
}

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
  s = String(s).trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const first = s.split(SEPS)[0] || s;
  return first.replace(/[^a-z0-9]+/g, " ").trim();
};

async function b1Post(path, payload, retries = 3) {
  const body = withAuth(payload);
  for (let i = 0; i < retries; i++) {
    try {
      const { data } = await axios.post(B1_BASE_URL + path, body, {
        headers: HEADERS,
        timeout: 60000,
        validateStatus: () => true, // we'll inspect body ourselves
      });
      // B1 sometimes returns {code:400,...} with HTTP 200. Fail fast on business error:
      if (data && typeof data === "object" && "code" in data && Number(data.code) >= 400) {
        throw new Error(`B1 error ${data.code}: ${data.message || "Unknown"} (${JSON.stringify(data.errors || {})})`);
      }
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
  const payload = { rows, page, sidx: "id", sord: "asc",
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
  if (grp) { cacheByName.set(key, grp); return grp; }
  if (DRY_RUN) return { id: -1, name };
  const created = await b1Post(B1_PATHS.groupCreate, { name });
  grp = { id: created.id, name };
  cacheByName.set(key, grp);
  return grp;
}

// --- item read helpers (to verify updates) ---
async function getItemById(id) {
  const payload = { rows: 1, page: 1, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "id", op: "eq", data: id }] },
  };
  const res = await b1Post(B1_PATHS.itemsList, payload);
  return (res?.rows || [])[0] || null;
}

// --- update helpers with verification & fallbacks ---
async function updateItemFields(itemId, fields, DRY_RUN) {
  if (DRY_RUN) { console.log("[DRY] update", itemId, fields); return { dryRun: true }; }
  const resp = await b1Post(B1_PATHS.itemUpdate, { id: itemId, ...fields });
  console.log("update resp:", itemId, fields, JSON.stringify(resp));
  return resp;
}

async function moveItemToGroup(itemId, targetGroup, targetName, DRY_RUN) {
  // Try by groupId first
  await updateItemFields(itemId, { groupId: targetGroup.id }, DRY_RUN);
  let after = await getItemById(itemId);
  if (after && String(after.groupId || "").toString() === String(targetGroup.id)) return true;

  // Fallback: try by group NAME (some tenants expect 'group' instead)
  await updateItemFields(itemId, { group: targetName }, DRY_RUN);
  after = await getItemById(itemId);
  const ok = after && (String(after.group || "").trim().toLowerCase() === targetName.trim().toLowerCase()
    || String(after.groupId || "").toString() === String(targetGroup.id));
  if (!ok) console.warn("Move failed for", itemId, "after:", after);
  return !!ok;
}

async function clearItemCode(itemId, DRY_RUN) {
  // Try code → itemCode → sku
  const tries = [ {code:""}, {itemCode:""}, {sku:""} ];
  for (const t of tries) {
    await updateItemFields(itemId, t, DRY_RUN);
    const after = await getItemById(itemId);
    const nowEmpty = [after?.code, after?.itemCode, after?.sku].some(v => String(v||"").trim() === "");
    if (nowEmpty) return true;
  }
  console.warn("Clear code failed for", itemId);
  return false;
}

async function itemsListByGroupId(groupId, page = 1, rows = 500) {
  const payload = { rows, page, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "groupId", op: "eq", data: groupId }] },
  };
  const res = await b1Post(B1_PATHS.itemsList, payload);
  return res?.rows || [];
}
async function deleteGroupById(groupId, DRY_RUN) {
  if (DRY_RUN) { console.log("[DRY] delete group", groupId); return { dryRun: true }; }
  const res = await b1Post(B1_PATHS.groupDelete, { id: groupId });
  console.log("delete group resp:", groupId, JSON.stringify(res));
  return res;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body  = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: "Body must include { items: [ ... ] }" });

    const DRY_RUN = body.dryRun ?? DEFAULT_DRY_RUN;
    const TARGET  = (body.targetGroupName || TARGET_GROUP_NAME).trim();

    // 0) tiny auth sanity call
    const sanity = await b1Post(B1_PATHS.itemsList, { rows:1, page:1, sidx:"id", sord:"asc", filters:{groupOp:"AND", rules:[]} });
    if (!sanity || !("rows" in sanity)) throw new Error("Auth/List sanity failed");

    // 1) ensure target group exists
    const allGroups = await listAllGroups();
    const cache = new Map(allGroups.map(g => [String(g.name||"").trim().toLowerCase(), g]));
    const targetGroup = await ensureGroupByExactName(TARGET, cache, DRY_RUN);

    // 2) filter: Pavadinimas starts with 'xxx'
    const isXxx = (s) => String(s || "").trim().toLowerCase().startsWith("xxx");
    const candidates = items.filter((it) => isXxx(it["Pavadinimas"]));

    // 3) move + clear code with verification
    const touchedKeys = new Set();
    let movedOk = 0, codeClearedOk = 0;

    const CHUNK = 100;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK);

      for (const it of chunk) {
        const name = it["Pavadinimas"] || "";
        const orig = (it["Grupė"] || "").trim();
        if (orig) touchedKeys.add(orig);
        const bw = baseWord(name); if (bw) touchedKeys.add(bw);

        const itemId = it["ID"];

        const mOk = await moveItemToGroup(itemId, targetGroup, TARGET, DRY_RUN);
        if (mOk) movedOk++;

        const cOk = await clearItemCode(itemId, DRY_RUN);
        if (cOk) codeClearedOk++;
      }
    }

    // 4) try deleting emptied groups (exact/fuzzy)
    let groupsChecked = 0, groupsDeleted = 0;
    for (const key of touchedKeys) {
      const hits = await groupsListByNameContains(key);
      if (!hits.length) continue;

      for (const g of hits) {
        const gName = String(g.name || "").trim();
        if (!gName || gName.toLowerCase() === TARGET.toLowerCase()) continue;

        const still = await itemsListByGroupId(g.id);
        groupsChecked++;
        if (!still.length) { await deleteGroupById(g.id, DRY_RUN); groupsDeleted++; }
      }
    }

    res.status(200).json({
      dryRun: !!DRY_RUN,
      targetGroup: TARGET,
      targetGroupId: targetGroup?.id,
      receivedItems: items.length,
      processedItems: candidates.length,
      movedOk,
      codeClearedOk,
      groupsChecked,
      groupsDeleted
    });
  } catch (e) {
    console.error("FATAL:", e?.response?.data || e);
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
};
