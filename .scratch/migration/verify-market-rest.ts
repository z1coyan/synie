import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";

interface APIErrorEnvelope {
  error?: { code?: string; message?: string };
}

interface ResourceMetaDocument {
  grid: unknown;
  form?: { exclude?: string[] };
}

interface Currency {
  id: string;
  name: string;
  isoCode: string;
  active: boolean;
}

interface Unit {
  id: string;
  name: string;
}

interface MarketInstrument {
  id: string;
  code: string;
  name: string;
  sourceType: "EXCHANGE" | "SPOT_INDEX" | "OTHER";
  defaultPriceKind: "SETTLEMENT" | "AVERAGE" | "LAST";
  active: boolean;
  fetchEnabled: boolean;
  externalLastCode: string | null;
  externalProductGroup: string | null;
  note: string | null;
  currencyId: string;
  unitId: string;
  insertedAt: string;
  updatedAt: string;
}

interface MarketPricePoint {
  id: string;
  observedAt: string;
  price: string;
  priceKind: "SETTLEMENT" | "AVERAGE" | "LAST";
  source: "MANUAL" | "FETCH";
  isVoided: boolean;
  note: string | null;
  instrumentId: string;
  currencyId: string;
  unitId: string;
  insertedAt: string;
  updatedAt: string;
}

interface MarketChartInstrument {
  id: string;
  instrumentId: string;
  code: string;
  name: string;
  currencyId: string;
  unitId: string;
  currencyCode: string | null;
  unitName: string | null;
  defaultPriceKind: "settlement" | "average" | "last";
}

interface MarketSeriesItem extends MarketChartInstrument {
  points: Array<{ observedAt: string; price: string }>;
}

interface MarketPriceSeries {
  priceKind: "settlement" | "average" | "last";
  from: string;
  to: string;
  series: MarketSeriesItem[];
}

interface MarketRefreshResult {
  items: Array<{
    instrumentId: string;
    code: string;
    kind: "settlement" | "average" | "last";
    status: "ok" | "skipped" | "error";
    message: string | null;
    pricePointId: string | null;
  }>;
  count: number;
}

type SystemRow = {
  id: string;
  marketFetchLastRunAt: Date | null;
  marketFetchLastSummary: string | null;
  updatedAt: Date;
};

const instrumentKeys = [
  "active",
  "code",
  "currencyId",
  "defaultPriceKind",
  "externalLastCode",
  "externalProductGroup",
  "fetchEnabled",
  "id",
  "insertedAt",
  "name",
  "note",
  "sourceType",
  "unitId",
  "updatedAt",
];
const pricePointKeys = [
  "currencyId",
  "id",
  "insertedAt",
  "instrumentId",
  "isVoided",
  "note",
  "observedAt",
  "price",
  "priceKind",
  "source",
  "unitId",
  "updatedAt",
];
const chartKeys = [
  "code",
  "currencyCode",
  "currencyId",
  "defaultPriceKind",
  "id",
  "instrumentId",
  "name",
  "unitId",
  "unitName",
];
const seriesItemKeys = [...chartKeys, "points"].sort();

async function requestText(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<string> {
  const response = await fetch(baseURL + path, init);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    let detail = text;
    try {
      const envelope = JSON.parse(text) as APIErrorEnvelope;
      detail = `${envelope.error?.code ?? "unknown"}:${envelope.error?.message ?? text}`;
    } catch {
      // 非 JSON 错误保留原始响应。
    }
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status}, ${detail}`,
    );
  }
  return text;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const text = await requestText(path, init, expectedStatus);
  return text === "" ? (undefined as T) : (JSON.parse(text) as T);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string) {
  const actualJSON = JSON.stringify(stable(actual));
  const expectedJSON = JSON.stringify(stable(expected));
  if (actualJSON !== expectedJSON) {
    throw new Error(
      `${label} 不一致\nactual=${JSON.stringify(actual, null, 2)}\nexpected=${JSON.stringify(expected, null, 2)}`,
    );
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
) {
  assertDeepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} keys`,
  );
}

function assertUTC(actual: string, expected: string, label: string) {
  if (new Date(actual).toISOString() !== new Date(expected).toISOString()) {
    throw new Error(`${label}=${actual}, want ${expected}`);
  }
}

function body(value: unknown) {
  return JSON.stringify(value);
}

const login = await request<{
  token: string;
  user: { id: string };
}>("/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body({ username, password }),
});
const headers = {
  Authorization: `Bearer ${login.token}`,
  "Content-Type": "application/json",
};
const db = new SQL(databaseURL);
const suffix = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)
  .toUpperCase();
const codePrefix = `ZZR29${suffix}`;
const instrumentIDs = new Set<string>();
const pointIDs = new Set<string>();
const cleanupAuditIDs = new Set<string>();
let originalSystem: SystemRow | null = null;
let baselineSystemAuditIDs = new Set<string>();

async function createInstrument(
  code: string,
  payload: Record<string, unknown>,
): Promise<MarketInstrument> {
  const created = await request<MarketInstrument>(
    "/base/market-instruments",
    {
      method: "POST",
      headers,
      body: body({ code, ...payload }),
    },
    201,
  );
  instrumentIDs.add(created.id);
  assertExactKeys(
    created as unknown as Record<string, unknown>,
    instrumentKeys,
    `instrument ${code}`,
  );
  return created;
}

async function createPricePoint(
  payload: Record<string, unknown>,
): Promise<MarketPricePoint> {
  const created = await request<MarketPricePoint>(
    "/base/market-price-points",
    {
      method: "POST",
      headers,
      body: body(payload),
    },
    201,
  );
  pointIDs.add(created.id);
  assertExactKeys(
    created as unknown as Record<string, unknown>,
    pricePointKeys,
    `price point ${created.id}`,
  );
  return created;
}

async function captureCleanupAuditIDs() {
  for (const recordID of [...instrumentIDs, ...pointIDs]) {
    const rows = (await db`
      SELECT id::text AS id
      FROM sys_audit_log
      WHERE record_id = ${recordID}::uuid
        AND resource IN ('bas_market_instrument', 'bas_market_price_point')
    `) as Array<{ id: string }>;
    for (const row of rows) cleanupAuditIDs.add(String(row.id));
  }
  if (originalSystem) {
    const rows = (await db`
      SELECT id::text AS id
      FROM sys_audit_log
      WHERE record_id = ${originalSystem.id}::uuid
        AND resource = 'sys_setting'
        AND action_name = 'record_market_fetch'
        AND actor_id = ${login.user.id}::uuid
    `) as Array<{ id: string }>;
    for (const row of rows) {
      const id = String(row.id);
      if (!baselineSystemAuditIDs.has(id)) cleanupAuditIDs.add(id);
    }
  }
}

try {
  const systemRows = (await db`
    SELECT
      id::text AS "id",
      market_fetch_last_run_at AS "marketFetchLastRunAt",
      market_fetch_last_summary AS "marketFetchLastSummary",
      updated_at AS "updatedAt"
    FROM sys_setting
    LIMIT 1
  `) as SystemRow[];
  originalSystem = systemRows[0] ?? null;
  if (!originalSystem) throw new Error("sys_setting 单例种子缺失");

  const existingSystemAudits = (await db`
    SELECT id::text AS id
    FROM sys_audit_log
    WHERE record_id = ${originalSystem.id}::uuid
      AND resource = 'sys_setting'
      AND action_name = 'record_market_fetch'
      AND actor_id = ${login.user.id}::uuid
  `) as Array<{ id: string }>;
  baselineSystemAuditIDs = new Set(
    existingSystemAudits.map((row) => String(row.id)),
  );

  const snapshotDir = join(import.meta.dir, "snapshots", "pr-2.9");
  const metaCases = [
    {
      resource: "basMarketInstruments",
      snapshot: "basMarketInstruments.grid.json",
      formExclude: ["id", "insertedAt", "updatedAt"],
    },
    {
      resource: "basMarketPricePoints",
      snapshot: "basMarketPricePoints.grid.json",
      formExclude: [
        "id",
        "isVoided",
        "currencyId",
        "unitId",
        "insertedAt",
        "updatedAt",
      ],
    },
  ];
  for (const item of metaCases) {
    const [document, captured] = await Promise.all([
      request<ResourceMetaDocument>(`/meta/resources/${item.resource}`, {
        headers,
      }),
      Bun.file(join(snapshotDir, item.snapshot)).json(),
    ]);
    assertDeepEqual(document.grid, captured, `${item.resource} GridMeta`);
    assertDeepEqual(
      [...(document.form?.exclude ?? [])].sort(),
      [...item.formExclude].sort(),
      `${item.resource} form.exclude`,
    );
  }

  const [currencies, units] = await Promise.all([
    request<{ results: Currency[] }>("/base/currencies/query", {
      method: "POST",
      headers,
      body: body({ limit: 200, offset: 0 }),
    }),
    request<{ results: Unit[] }>("/base/units/query", {
      method: "POST",
      headers,
      body: body({ limit: 200, offset: 0 }),
    }),
  ]);
  const currency = currencies.results.find((item) => item.active);
  const primaryUnit = units.results[0];
  const alternateUnit = units.results.find(
    (item) => item.id !== primaryUnit?.id,
  );
  if (!currency || !primaryUnit || !alternateUnit) {
    throw new Error("行情 REST 验收至少需要一个启用币种和两个计量单位种子");
  }

  const baseInstrument = {
    name: `REST行情-${suffix}`,
    sourceType: "EXCHANGE",
    defaultPriceKind: "SETTLEMENT",
    currencyId: currency.id,
    unitId: primaryUnit.id,
  };
  const primary = await createInstrument(`${codePrefix}A`, baseInstrument);
  if (!primary.active || primary.fetchEnabled) {
    throw new Error(
      `品种默认值错误: active=${primary.active}, fetchEnabled=${primary.fetchEnabled}`,
    );
  }
  if (
    primary.externalLastCode !== null ||
    primary.externalProductGroup !== null ||
    primary.note !== null
  ) {
    throw new Error(`品种可空默认值错误: ${JSON.stringify(primary)}`);
  }

  await request<unknown>(
    "/base/market-instruments",
    {
      method: "POST",
      headers,
      body: body({ code: primary.code, ...baseInstrument }),
    },
    409,
  );

  const secondary = await createInstrument(`${codePrefix}B`, {
    ...baseInstrument,
    name: `REST行情空序列-${suffix}`,
    defaultPriceKind: "LAST",
  });
  const inactive = await createInstrument(`${codePrefix}C`, {
    ...baseInstrument,
    name: `REST行情停用-${suffix}`,
    active: false,
    fetchEnabled: true,
  });
  const crossScale = await createInstrument(`${codePrefix}D`, {
    ...baseInstrument,
    name: `REST行情跨单位-${suffix}`,
    unitId: alternateUnit.id,
  });
  const deletable = await createInstrument(`${codePrefix}E`, {
    ...baseInstrument,
    name: `REST行情可删除-${suffix}`,
  });

  const listed = await request<{
    count: number;
    results: MarketInstrument[];
  }>("/base/market-instruments/query", {
    method: "POST",
    headers,
    body: body({ limit: 200, offset: 0, search: codePrefix }),
  });
  assertDeepEqual(
    listed.results.map((item) => item.code),
    [
      primary.code,
      secondary.code,
      inactive.code,
      crossScale.code,
      deletable.code,
    ],
    "instrument query 默认顺序",
  );

  await request<unknown>(
    `/base/market-instruments/${primary.id}`,
    {
      method: "PATCH",
      headers,
      body: body({
        code: `${primary.code}X`,
        sourceType: "OTHER",
        currencyId: crypto.randomUUID(),
        unitId: crypto.randomUUID(),
      }),
    },
    400,
  );
  const unchanged = await request<MarketInstrument>(
    `/base/market-instruments/${primary.id}`,
    { headers },
  );
  if (
    unchanged.code !== primary.code ||
    unchanged.sourceType !== primary.sourceType ||
    unchanged.currencyId !== primary.currencyId ||
    unchanged.unitId !== primary.unitId
  ) {
    throw new Error(`不可变字段被改写: ${JSON.stringify(unchanged)}`);
  }

  const updated = await request<MarketInstrument>(
    `/base/market-instruments/${primary.id}`,
    {
      method: "PATCH",
      headers,
      body: body({
        name: `REST行情已更新-${suffix}`,
        defaultPriceKind: "AVERAGE",
        active: false,
        fetchEnabled: true,
        externalLastCode: "REST_NO_NETWORK",
        externalProductGroup: "rest",
        note: "REST update acceptance",
      }),
    },
  );
  if (
    updated.name !== `REST行情已更新-${suffix}` ||
    updated.defaultPriceKind !== "AVERAGE" ||
    updated.active ||
    !updated.fetchEnabled ||
    updated.externalLastCode !== "REST_NO_NETWORK" ||
    updated.externalProductGroup !== "rest" ||
    updated.note !== "REST update acceptance"
  ) {
    throw new Error(`品种可变字段更新错误: ${JSON.stringify(updated)}`);
  }
  const restored = await request<MarketInstrument>(
    `/base/market-instruments/${primary.id}`,
    {
      method: "PATCH",
      headers,
      body: body({
        name: baseInstrument.name,
        defaultPriceKind: "SETTLEMENT",
        active: true,
        fetchEnabled: false,
        externalLastCode: null,
        externalProductGroup: null,
        note: null,
      }),
    },
  );
  if (
    restored.name !== baseInstrument.name ||
    restored.defaultPriceKind !== "SETTLEMENT" ||
    !restored.active ||
    restored.fetchEnabled ||
    restored.externalLastCode !== null ||
    restored.externalProductGroup !== null ||
    restored.note !== null
  ) {
    throw new Error(`品种恢复更新错误: ${JSON.stringify(restored)}`);
  }

  await request<void>(
    `/base/market-instruments/${deletable.id}`,
    { method: "DELETE", headers },
    204,
  );
  await request<unknown>(
    `/base/market-instruments/${deletable.id}`,
    { headers },
    404,
  );

  const chart = await request<MarketChartInstrument[]>(
    "/base/market-price-points/chart-instruments",
    { headers },
  );
  const ownChart = chart.filter((item) => item.code?.startsWith(codePrefix));
  const expectedChart: MarketChartInstrument[] = [
    {
      id: primary.id,
      instrumentId: primary.id,
      code: primary.code,
      name: baseInstrument.name,
      currencyId: currency.id,
      unitId: primaryUnit.id,
      currencyCode: currency.isoCode,
      unitName: primaryUnit.name,
      defaultPriceKind: "settlement",
    },
    {
      id: secondary.id,
      instrumentId: secondary.id,
      code: secondary.code,
      name: secondary.name,
      currencyId: currency.id,
      unitId: primaryUnit.id,
      currencyCode: currency.isoCode,
      unitName: primaryUnit.name,
      defaultPriceKind: "last",
    },
    {
      id: crossScale.id,
      instrumentId: crossScale.id,
      code: crossScale.code,
      name: crossScale.name,
      currencyId: currency.id,
      unitId: alternateUnit.id,
      currencyCode: currency.isoCode,
      unitName: alternateUnit.name,
      defaultPriceKind: "settlement",
    },
  ];
  for (const [index, item] of ownChart.entries()) {
    assertExactKeys(
      item as unknown as Record<string, unknown>,
      chartKeys,
      `chart[${index}]`,
    );
  }
  assertDeepEqual(ownChart, expectedChart, "chart active/sort/exact shape");

  const from = "2024-02-03T04:05:06Z";
  const middle = "2024-02-03T05:05:06Z";
  const to = "2024-02-04T04:05:06Z";
  await request<unknown>(
    "/base/market-price-points",
    {
      method: "POST",
      headers,
      body: body({
        instrumentId: primary.id,
        observedAt: middle,
        price: "0",
      }),
    },
    400,
  );

  const originalPoint = await createPricePoint({
    instrumentId: primary.id,
    observedAt: from,
    price: "101.25",
    note: "will be voided",
  });
  if (
    originalPoint.priceKind !== "SETTLEMENT" ||
    originalPoint.source !== "MANUAL" ||
    originalPoint.currencyId !== primary.currencyId ||
    originalPoint.unitId !== primary.unitId ||
    originalPoint.isVoided
  ) {
    throw new Error(`价点继承/默认值错误: ${JSON.stringify(originalPoint)}`);
  }
  assertUTC(originalPoint.observedAt, from, "created observedAt");

  await request<unknown>(
    "/base/market-price-points",
    {
      method: "POST",
      headers,
      body: body({
        instrumentId: primary.id,
        observedAt: from,
        price: "199",
        priceKind: "SETTLEMENT",
      }),
    },
    409,
  );
  const voided = await request<MarketPricePoint>(
    `/base/market-price-points/${originalPoint.id}/void`,
    { method: "POST", headers },
  );
  if (!voided.isVoided) throw new Error("价点首次作废后 isVoided=false");
  await request<unknown>(
    `/base/market-price-points/${originalPoint.id}/void`,
    { method: "POST", headers },
    400,
  );

  const rerecorded = await createPricePoint({
    instrumentId: primary.id,
    observedAt: from,
    price: "102.5",
  });
  if (rerecorded.id === originalPoint.id || rerecorded.isVoided) {
    throw new Error(`作废后重录错误: ${JSON.stringify(rerecorded)}`);
  }
  const boundary = await createPricePoint({
    instrumentId: primary.id,
    observedAt: to,
    price: "103",
    priceKind: "SETTLEMENT",
  });
  const otherKind = await createPricePoint({
    instrumentId: primary.id,
    observedAt: middle,
    price: "999",
    priceKind: "LAST",
  });

  const pointList = await request<{
    count: number;
    results: MarketPricePoint[];
  }>("/base/market-price-points/query", {
    method: "POST",
    headers,
    body: body({
      limit: 200,
      offset: 0,
      filter: {
        instrumentId: {
          kind: "fk",
          values: [primary.id],
          labels: [],
        },
      },
    }),
  });
  if (
    pointList.count !== 4 ||
    new Set(pointList.results.map((item) => item.id)).size !== 4
  ) {
    throw new Error(`价点 query 结果错误: ${JSON.stringify(pointList)}`);
  }

  const series = await request<MarketPriceSeries>(
    "/base/market-price-points/price-series",
    {
      method: "POST",
      headers,
      body: body({
        instrumentIds: [secondary.id, primary.id, secondary.id],
        priceKind: "SETTLEMENT",
        from,
        to,
      }),
    },
  );
  assertExactKeys(
    series as unknown as Record<string, unknown>,
    ["priceKind", "from", "to", "series"],
    "price series",
  );
  assertUTC(series.from, from, "series.from");
  assertUTC(series.to, to, "series.to");
  for (const [index, item] of series.series.entries()) {
    assertExactKeys(
      item as unknown as Record<string, unknown>,
      seriesItemKeys,
      `series[${index}]`,
    );
    for (const [pointIndex, point] of item.points.entries()) {
      assertExactKeys(
        point as unknown as Record<string, unknown>,
        ["observedAt", "price"],
        `series[${index}].points[${pointIndex}]`,
      );
    }
  }
  assertDeepEqual(
    series,
    {
      priceKind: "settlement",
      from,
      to,
      series: [
        {
          ...expectedChart[1],
          points: [],
        },
        {
          ...expectedChart[0],
          points: [
            { observedAt: from, price: "102.5" },
            { observedAt: to, price: "103" },
          ],
        },
      ],
    },
    "series order/dedupe/skeleton/kind/void/bounds",
  );

  const emptySeries = await request<MarketPriceSeries>(
    "/base/market-price-points/price-series",
    {
      method: "POST",
      headers,
      body: body({ instrumentIds: [], priceKind: "LAST", from, to }),
    },
  );
  assertDeepEqual(
    emptySeries,
    { priceKind: "last", from, to, series: [] },
    "empty series",
  );
  await request<unknown>(
    "/base/market-price-points/price-series",
    {
      method: "POST",
      headers,
      body: body({
        instrumentIds: [primary.id, crossScale.id],
        priceKind: "SETTLEMENT",
        from,
        to,
      }),
    },
    400,
  );
  await request<unknown>(
    "/base/market-price-points/price-series",
    {
      method: "POST",
      headers,
      body: body({
        instrumentIds: [primary.id],
        priceKind: "SETTLEMENT",
        from: to,
        to: from,
      }),
    },
    400,
  );
  await request<unknown>(
    "/base/market-price-points/price-series",
    {
      method: "POST",
      headers,
      body: body({
        instrumentIds: Array.from({ length: 7 }, () => crypto.randomUUID()),
        priceKind: "SETTLEMENT",
        from,
        to,
      }),
    },
    400,
  );
  await request<unknown>(
    "/base/market-price-points/price-series",
    {
      method: "POST",
      headers,
      body: body({
        instrumentIds: [crypto.randomUUID()],
        priceKind: "SETTLEMENT",
        from,
        to,
      }),
    },
    400,
  );

  for (const point of [rerecorded, boundary, otherKind]) {
    const result = await request<MarketPricePoint>(
      `/base/market-price-points/${point.id}/void`,
      { method: "POST", headers },
    );
    if (!result.isVoided) throw new Error(`价点未作废: ${point.id}`);
  }
  await request<unknown>(
    `/base/market-instruments/${primary.id}`,
    { method: "DELETE", headers },
    409,
  );

  const refreshCases = [
    { label: "不存在品种", instrumentId: crypto.randomUUID() },
    { label: "停用品种", instrumentId: inactive.id },
    { label: "未启用拉取品种", instrumentId: primary.id },
  ];
  for (const item of refreshCases) {
    const result = await request<MarketRefreshResult>(
      "/base/market-price-points/refresh",
      {
        method: "POST",
        headers,
        body: body({ instrumentId: item.instrumentId }),
      },
    );
    assertExactKeys(
      result as unknown as Record<string, unknown>,
      ["items", "count"],
      `refresh ${item.label}`,
    );
    assertDeepEqual(result, { items: [], count: 0 }, `refresh ${item.label}`);
  }
  const fetchStatus = await request<{
    marketFetchLastRunAt: string | null;
    marketFetchLastSummary: string | null;
  }>("/settings/system", { headers });
  if (
    fetchStatus.marketFetchLastRunAt === null ||
    fetchStatus.marketFetchLastSummary !== "手动刷新: 成功0 跳过0 失败0"
  ) {
    throw new Error(`空刷新运行摘要错误: ${JSON.stringify(fetchStatus)}`);
  }

  await captureCleanupAuditIDs();
  const marketAudits = (await db`
    SELECT record_id::text AS "recordId", action_name AS "actionName"
    FROM sys_audit_log
    WHERE record_id IN (
      ${primary.id}::uuid,
      ${originalPoint.id}::uuid,
      ${rerecorded.id}::uuid
    )
    ORDER BY inserted_at
  `) as Array<{ recordId: string; actionName: string }>;
  const actionsByRecord = new Map<string, string[]>();
  for (const row of marketAudits) {
    const actions = actionsByRecord.get(row.recordId) ?? [];
    actions.push(row.actionName);
    actionsByRecord.set(row.recordId, actions);
  }
  for (const [recordID, expected] of [
    [primary.id, ["create", "update", "update"]],
    [originalPoint.id, ["create", "void"]],
    [rerecorded.id, ["create", "void"]],
  ] as const) {
    assertDeepEqual(
      actionsByRecord.get(recordID) ?? [],
      expected,
      `audit ${recordID}`,
    );
  }

  console.log(
    `market REST acceptance ok: meta=2 instruments=${instrumentIDs.size} points=${pointIDs.size} chart=${ownChart.length} series=${series.series.length} refresh=${refreshCases.length} audits=${cleanupAuditIDs.size}`,
  );
} finally {
  let cleanupError: unknown;
  try {
    await captureCleanupAuditIDs();

    for (const pointID of pointIDs) {
      await db`
        DELETE FROM bas_market_price_point
        WHERE id = ${pointID}::uuid
      `;
    }
    for (const instrumentID of instrumentIDs) {
      await db`
        DELETE FROM bas_market_price_point
        WHERE instrument_id = ${instrumentID}::uuid
      `;
      await db`
        DELETE FROM bas_market_instrument
        WHERE id = ${instrumentID}::uuid
      `;
    }
    if (originalSystem) {
      await db`
        UPDATE sys_setting
        SET
          market_fetch_last_run_at = ${originalSystem.marketFetchLastRunAt},
          market_fetch_last_summary = ${originalSystem.marketFetchLastSummary},
          updated_at = ${originalSystem.updatedAt}
        WHERE id = ${originalSystem.id}::uuid
      `;
    }
    for (const auditID of cleanupAuditIDs) {
      await db`
        DELETE FROM sys_audit_log
        WHERE id = ${auditID}::uuid
      `;
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    await db.close();
  }
  if (cleanupError) {
    throw new AggregateError([cleanupError], "Market REST 验收清理失败");
  }
}
