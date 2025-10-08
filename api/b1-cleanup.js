// Vercel Serverless Function (Node 18+)
const axios = require("axios");

// -------- CONFIG (edit these 2 if needed) ----------
let B1_BASE_URL = "https://www.b1.lt"; // will auto-fallback to https://api.b1.lt if needed
const B1_API_KEY = "a66da08c93a85ed160bcf819e69f458efb15b2ade976d605685852f4a1ef5b70";
const COMPANY_ID = ""; // e.g. "123" if your tenant requires it, else leave ""
const TARGET_GROUP_NAME = "xxx_pvz grupė";
const DEFAULT_DRY_RUN = false;
// ---------------------------------------------------

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "B1-Api-Key": B1_API_KEY,              // <-- the only auth signal
  ...(COMPANY_ID ? { "X-Company-Id": COMPANY_ID } : {}),
};

async function b1Post(path, payload, retries = 2) {
  // do NOT inject apiKey into body; B1 wants the header
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.post(B1_BASE_URL + path, payload, {
        headers: HEADERS,
        timeout: 60000,
        validateStatus: () => true,
      });
      if (data && typeof data === "object" && Number(data.code) >= 400) {
        // If API key is invalid from this host, try the api.* host once
        const headerErr = JSON.stringify(data.errors || {});
        const badKey = /raktas|api key|neteisingas|invalid/i.test(headerErr);
        if (badKey && B1_BASE_URL === "https://www.b1.lt") {
          B1_BASE_URL = "https://api.b1.lt"; // switch host once
          continue; // retry the same request on api.* host
        }
        throw new Error(`B1 error ${data.code}: ${data.message} (${headerErr})`);
      }
      return data;
    } catch (err) {
      const status = err?.response?.status;
      if ([429,500,502,503,504].includes(status) && i < retries) {
        await new Promise(r => setTimeout(r, 1200*(i+1)));
        continue;
      }
      throw err;
    }
  }
}

// ---- minimal helpers (unchanged logic) ----
const PATHS = {
  itemsList:  "/api/reference-book/items/list",
  itemUpdate: "/api/reference-book/items/update",
  groupsList: "/api/reference-book/item-groups/list",
  groupCreate:"/api/reference-book/item-groups/create",
  groupDelete:"/api/reference-book/item-groups/delete",
};
async function listAllGroups() {
  const out = []; let page = 1;
  for (;;) {
    const res = await b1Post(PATHS.groupsList, {
      rows: 500, page, sidx: "id", sord: "asc",
      filters: { groupOp: "AND", rules: [] },
    });
    const rows = res?.rows || [];
    if (!rows.length) break;
    out.push(...rows); page++;
  }
  return out;
}
async function ensureGroupByName(name, cache, dry) {
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const res = await b1Post(PATHS.groupsList, {
    rows: 50, page: 1, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "name", op: "cn", data: name }] },
  });
  let hit = (res?.rows||[]).find(g => String(g.name||"").trim().toLowerCase() === key);
  if (hit) { cache.set(key, hit); return hit; }
  if (dry) return { id: -1, name };
  const created = await b1Post(PATHS.groupCreate, { name });
  hit = { id: created.id, name };
  cache.set(key, hit);
  return hit;
}
async function updateItem(id, fields, dry) {
  if (dry) return { dryRun:true };
  const resp = await b1Post(PATHS.itemUpdate, { id, ...fields });
  return resp;
}
async function getItemById(id) {
  const res = await b1Post(PATHS.itemsList, {
    rows: 1, page: 1, sidx: "id", sord: "asc",
    filters: { groupOp:"AND", rules:[{ field:"id", op:"eq", data:id }] }
  });
  return (res?.rows||[])[0] || null;
}
// --------------------------------------------

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body  = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: "Body must include { items: [...] }" });

    const DRY_RUN = body.dryRun ?? DEFAULT_DRY_RUN;
    const TARGET  = (body.targetGroupName || TARGET_GROUP_NAME).trim();

    // 0) sanity: prove auth on this host (auto-swaps to api.* if www.* rejects)
    const sanity = await b1Post(PATHS.itemsList, {
      rows: 1, page: 1, sidx: "id", sord: "asc",
      filters: { groupOp:"AND", rules:[] }
    });
    if (!sanity || !("rows" in sanity)) {
      return res.status(500).json({ error: "Auth/list sanity failed" });
    }

    // 1) ensure group
    const allGroups = await listAllGroups();
    const cache = new Map(allGroups.map(g => [String(g.name||"").trim().toLowerCase(), g]));
    const targetGroup = await ensureGroupByName(TARGET, cache, DRY_RUN);

    // 2) pick candidates
    const isXxx = s => String(s||"").trim().toLowerCase().startsWith("xxx");
    const candidates = items.filter(it => isXxx(it["Pavadinimas"]));

    // 3) move & clear code (verify after)
    let movedOk = 0, codeClearedOk = 0;
    for (const it of candidates) {
      const id = it["ID"];

      // move by groupId
      await updateItem(id, { groupId: targetGroup.id }, DRY_RUN);
      let snap = await getItemById(id);
      const moved = snap && String(snap.groupId||"") === String(targetGroup.id);
      if (!moved) {
        // fallback: by name
        await updateItem(id, { group: TARGET }, DRY_RUN);
        snap = await getItemById(id);
      }
      if (snap && (String(snap.groupId||"") === String(targetGroup.id) ||
                   String(snap.group||"").trim().toLowerCase() === TARGET.toLowerCase())) movedOk++;

      // clear code (try code -> itemCode -> sku)
      for (const f of ["code","itemCode","sku"]) {
        await updateItem(id, { [f]: "" }, DRY_RUN);
        const after = await getItemById(id);
        const empty = ["code","itemCode","sku"].every(k => String(after?.[k] ?? "").trim() === "");
        if (empty) { codeClearedOk++; break; }
      }
    }

    res.status(200).json({
      baseUrlUsed: B1_BASE_URL,
      dryRun: DRY_RUN,
      targetGroup: TARGET,
      targetGroupId: targetGroup?.id,
      receivedItems: items.length,
      processedItems: candidates.length,
      movedOk,
      codeClearedOk
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
};
