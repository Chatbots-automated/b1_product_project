// Vercel Serverless Function (Node 18+)
const axios = require("axios");

// -------- CONFIG ----------
let B1_BASE_URL = "https://www.b1.lt"; // will try api.b1.lt if the key is rejected
const B1_API_KEY = "a66da08c93a85ed160bcf819e69f458efb15b2ade976d605685852f4a1ef5b70";
const COMPANY_ID = ""; // optional: "123"
const TARGET_GROUP_NAME = "xxx_pvz grupė";
const DEFAULT_DRY_RUN = false;
const SAFE_ROWS = 50; // must be one of 10,20,30,50,100,200,500
// ---------------------------------------------------

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "B1-Api-Key": B1_API_KEY,
  ...(COMPANY_ID ? { "X-Company-Id": COMPANY_ID } : {}),
};

const DEBUG_MAX = 12;
const _debug = [];
function addDebug(kind, obj) {
  try {
    const cleaned = JSON.parse(JSON.stringify(obj));
    if (cleaned?.headers?.["B1-Api-Key"]) cleaned.headers["B1-Api-Key"] = "***";
    _debug.push({ t: new Date().toISOString(), kind, ...cleaned });
    if (_debug.length > DEBUG_MAX) _debug.shift();
  } catch {
    _debug.push({ t: new Date().toISOString(), kind, note: "debug-serialize-failed" });
  }
}

function trunc(x, max = 1200) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

async function b1Post(path, payload, retries = 2) {
  const url = B1_BASE_URL + path;
  addDebug("request", { url, headers: HEADERS, payload });
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await axios.post(url, payload, {
        headers: HEADERS,
        timeout: 60000,
        validateStatus: () => true,
      });
      const { status, data } = res;
      addDebug("response", { url, status, data: trunc(data) });

      // B1 often returns HTTP 200 with a business error { code: 400, errors: {...} }
      if (data && typeof data === "object" && Number(data.code) >= 400) {
        const errs = JSON.stringify(data.errors || {});
        const badKey = /raktas|api key|neteisingas|invalid/i.test(errs);
        if (badKey && B1_BASE_URL === "https://www.b1.lt") {
          B1_BASE_URL = "https://api.b1.lt";
          addDebug("info", { msg: "Switched host to https://api.b1.lt due to key error" });
          return b1Post(path, payload, retries - i);
        }
        throw new Error(`B1 error ${data.code}: ${data.message} (${errs})`);
      }
      if (status >= 400) throw new Error(`HTTP ${status}: ${trunc(data)}`);
      return data;
    } catch (err) {
      const status = err?.response?.status;
      addDebug("error", { url, status, message: String(err?.message || err) });
      if ([429, 500, 502, 503, 504].includes(status) && i < retries) {
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// -------- B1 endpoints --------
const PATHS = {
  itemsList:  "/api/reference-book/items/list",
  itemUpdate: "/api/reference-book/items/update",
  groupsList: "/api/reference-book/item-groups/list",
  groupUpdate:"/api/reference-book/item-groups/update", // from your docs
  groupDelete:"/api/reference-book/item-groups/delete",
};

// Read 1 item by ID (so we can send a full update incl. required fields)
async function getItemById(id) {
  const res = await b1Post(PATHS.itemsList, {
    rows: SAFE_ROWS, page: 1, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "id", op: "eq", data: id }] },
  });
  const row = (res?.rows || [])[0] || null;
  addDebug("info", { msg: "getItemById", id, found: !!row });
  return row;
}

// Find target group by exact name
async function getGroupByExactName(name) {
  const res = await b1Post(PATHS.groupsList, {
    rows: SAFE_ROWS, page: 1, sidx: "id", sord: "asc",
    filters: { groupOp: "AND", rules: [{ field: "name", op: "cn", data: name }] },
  });
  const rows = res?.rows || [];
  const exact = rows.find(g => String(g.name || "").trim().toLowerCase() === name.trim().toLowerCase());
  addDebug("info", { msg: "getGroupByExactName", name, found: !!exact, totalHits: rows.length });
  return exact || null;
}

// Update item with ALL required fields preserved
async function updateItemFull(existing, patch, dry) {
  if (dry) { addDebug("dry-update", { id: existing.id, patch }); return { dryRun: true }; }

  // Items.update requires: id, name, attributeId, measurementUnitId (from your doc)
  const payload = {
    id: existing.id,
    name: existing.name, // preserve
    attributeId: existing.attributeId, // preserve
    measurementUnitId: existing.measurementUnitId, // preserve
    // optional fields we preserve if present (keeps validator happy)
    manufacturerId: existing.manufacturerId,
    countryOfOriginId: existing.countryOfOriginId,
    description: existing.description,
    purchaseCorrespondenceAccountId: existing.purchaseCorrespondenceAccountId,
    saleCorrespondenceAccountId: existing.saleCorrespondenceAccountId,
    expenseCorrespondenceAccountId: existing.expenseCorrespondenceAccountId,
    priceWithoutVat: existing.priceWithoutVat,
    vatRate: existing.vatRate,
    priceWithVat: existing.priceWithVat,
    barcode: existing.barcode,
    minQuantity: existing.minQuantity,
    freePrice: existing.freePrice,
    externalId: existing.externalId,
    intrastatId: existing.intrastatId,
    isActive: existing.isActive,
    isRefundable: existing.isRefundable,
    isCommentRequired: existing.isCommentRequired,
    priceFrom: existing.priceFrom,
    priceUntil: existing.priceUntil,
    minPriceWithVat: existing.minPriceWithVat,
    priceMinQuantity: existing.priceMinQuantity,
    discountStatus: existing.discountStatus,
    maxDiscount: existing.maxDiscount,
    discountPointsStatus: existing.discountPointsStatus,
    departmentNumber: existing.departmentNumber,
    ageLimit: existing.ageLimit,
    packageQuantity: existing.packageQuantity,
    packageCode: existing.packageCode,
    certificateDate: existing.certificateDate,
    certificateNumber: existing.certificateNumber,
    validFrom: existing.validFrom,
    validUntil: existing.validUntil,
    attribute1: existing.attribute1,
    attribute2: existing.attribute2,
    attribute3: existing.attribute3,
    // our changes:
    ...patch, // e.g., { groupId: X } or { code: "" }
  };

  const resp = await b1Post(PATHS.itemUpdate, payload);
  addDebug("updateItemFull", { id: existing.id, patch, resp: trunc(resp) });
  return resp;
}

// Delete groups by IDs
async function deleteGroups(ids, dry) {
  if (!ids?.length) return { skipped: true };
  if (dry) { addDebug("dry-delete-groups", { ids }); return { dryRun: true }; }
  const resp = await b1Post(PATHS.groupDelete, { ids }); // <-- per docs, array
  addDebug("deleteGroups", { ids, resp: trunc(resp) });
  return resp;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body  = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: "Body must include { items: [...] }" });

    const DRY_RUN = body.dryRun ?? DEFAULT_DRY_RUN;
    const TARGET  = (body.targetGroupName || TARGET_GROUP_NAME).trim();

    addDebug("start", { baseUrl: B1_BASE_URL, dryRun: DRY_RUN, itemsCount: items.length, target: TARGET });

    // 0) quick sanity list with SAFE_ROWS
    const sanity = await b1Post(PATHS.itemsList, {
      rows: SAFE_ROWS, page: 1, sidx: "id", sord: "asc",
      filters: { groupOp: "AND", rules: [] },
    });
    if (!sanity || !("rows" in sanity)) {
      return res.status(500).json({ error: "Auth/list sanity failed", debug: _debug });
    }

    // 1) ensure target group exists (we only read; creation via update endpoint isn't supported)
    const targetGroup = await getGroupByExactName(TARGET);
    if (!targetGroup) {
      return res.status(400).json({
        error: `Target group "${TARGET}" not found. Please create it once in B1 UI.`,
        debug: _debug
      });
    }

    // 2) choose candidates: Pavadinimas starts with 'xxx'
    const isXxx = s => String(s||"").trim().toLowerCase().startsWith("xxx");
    const candidates = items.filter(it => isXxx(it["Pavadinimas"]));
    addDebug("info", { msg: "candidates", count: candidates.length });

    // 3) move + clear code (with full payloads)
    let movedOk = 0, codeClearedOk = 0;
    const touchedGroupIds = new Set();

    for (const it of candidates) {
      const id = it["ID"];
      const before = await getItemById(id);
      if (!before) { addDebug("warn", { msg: "item not found in B1 by ID", id }); continue; }

      // remember original group to check deletion later
      if (before.groupId) touchedGroupIds.add(Number(before.groupId));

      // move to target group
      await updateItemFull(before, { groupId: targetGroup.id }, DRY_RUN);
      const afterMove = await getItemById(id);
      if (afterMove && String(afterMove.groupId || "") === String(targetGroup.id)) movedOk++;

      // clear code: send empty string (doc shows string; empty string accepted on most tenants)
      await updateItemFull(afterMove || before, { code: "" }, DRY_RUN);
      const afterClear = await getItemById(id);
      const codeIsEmpty = String(afterClear?.code ?? "").trim() === "";
      if (codeIsEmpty) codeClearedOk++;
    }

    // 4) try to delete emptied groups (skip target)
    let groupsChecked = 0, groupsDeleted = 0;
    const delIds = [];
    for (const gid of touchedGroupIds) {
      if (String(gid) === String(targetGroup.id)) continue;

      // count items in this group
      const resp = await b1Post(PATHS.itemsList, {
        rows: SAFE_ROWS, page: 1, sidx: "id", sord: "asc",
        filters: { groupOp: "AND", rules: [{ field: "groupId", op: "eq", data: gid }] },
      });
      const hasAny = (resp?.rows || []).length > 0;
      groupsChecked++;
      if (!hasAny) delIds.push(Number(gid));
    }
    if (delIds.length) {
      await deleteGroups(delIds, DRY_RUN);
      groupsDeleted = delIds.length;
    }

    res.status(200).json({
      baseUrlUsed: B1_BASE_URL,
      dryRun: DRY_RUN,
      targetGroup: TARGET,
      targetGroupId: targetGroup?.id,
      receivedItems: items.length,
      processedItems: candidates.length,
      movedOk,
      codeClearedOk,
      groupsChecked,
      groupsDeleted,
      debug: _debug,
    });
  } catch (e) {
    addDebug("fatal", { message: e?.message || String(e) });
    return res.status(500).json({ error: e?.message || String(e), debug: _debug });
  }
};
