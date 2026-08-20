import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { loginViaUI, sessionCookieHeader } from "./fixtures/session";

const goAPIURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const suffix = Date.now().toString(36);
const code = `E2E_MKT_${suffix}`;
const originalName = `浏览器测试行情-${suffix}`;
const updatedName = `浏览器测试行情已更新-${suffix}`;

type Currency = { id: string; isoCode: string; name: string };
type Unit = { id: string; name: string };
type List<T> = { count: number; results: T[] };

async function queryFirst<T>(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
): Promise<T> {
  // page.request 与浏览器同 context,自动携带会话 cookie
  const response = await request.post(`/api/v1${path}`, { data });
  const text = await response.text();
  expect(response.ok(), `${path}: ${response.status()} ${text}`).toBeTruthy();
  const body = JSON.parse(text) as List<T>;
  expect(
    body.results.length,
    `${path} 需要至少一条测试基础数据`,
  ).toBeGreaterThan(0);
  return body.results[0]!;
}

async function cleanupInstrument(
  cookie: { Cookie: string },
  id: string,
): Promise<void> {
  // 直连 API origin,cookie 域是前端 origin,需显式带 Cookie 头
  const response = await fetch(`${goAPIURL}/base/market-instruments/${id}`, {
    method: "DELETE",
    headers: cookie,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `cleanup market instrument: ${response.status} ${await response.text()}`,
    );
  }
}

async function chooseOption(
  page: Page,
  drawer: ReturnType<Page["getByRole"]>,
  _label: string,
  option: string,
): Promise<void> {
  const trigger = drawer
    .getByRole(`group`)
    .filter({ hasText: `请选择…` })
    .first();
  await expect(trigger).toHaveCount(1, { timeout: 5_000 });
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("listbox", { name: "选项" })).toBeVisible();
  const choice = page.getByRole("option").filter({ hasText: option }).first();
  await expect(choice).toHaveCount(1, { timeout: 5_000 });
  await choice.click();
  await expect(page.getByRole("listbox", { name: "选项" })).toBeHidden();
}

test.setTimeout(120_000);

test("行情 Grid、Drawer、图表与远程选择器全程使用 Go REST", async ({
  page,
}) => {
  await loginViaUI(page);
  const cookie = await sessionCookieHeader(page.context());
  const [currency, unit] = await Promise.all([
    queryFirst<Currency>(page.request, "/base/currencies/query", {
      limit: 1,
      offset: 0,
      sort: { column: "isoCode", direction: "ascending" },
      filter: { active: { kind: "bool", eq: true } },
    }),
    queryFirst<Unit>(page.request, "/base/units/query", {
      limit: 1,
      offset: 0,
      sort: { column: "name", direction: "ascending" },
    }),
  ]);

  const graphqlRequests: Array<{ url: string; body: string | null }> = [];
  const restRequests: string[] = [];
  let createdId: string | null = null;
  page.on("request", (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname;
    if (pathname === "/graphql") {
      graphqlRequests.push({ url: outgoing.url(), body: outgoing.postData() });
    }
    if (
      pathname.startsWith("/api/v1/base/market-") ||
      pathname === "/api/v1/base/currencies/query" ||
      pathname === "/api/v1/base/units/query" ||
      pathname.includes("/api/v1/meta/resources/basMarket")
    ) {
      restRequests.push(`${outgoing.method()} ${pathname}`);
    }
  });

  try {
    await page.goto("/base/market");
    await expect(
      page.getByRole("heading", { name: "行情", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("grid", { name: "basMarketPricePoints 数据表格" }),
    ).toBeVisible();

    await page.getByRole("tab", { name: "品种维护", exact: true }).click();
    await expect(
      page.getByRole("grid", { name: "basMarketInstruments 数据表格" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新增", exact: true }).click();

    const createDrawer = page.getByRole("dialog", { name: "新增行情品种" });
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByLabel("编码").fill(code);
    await createDrawer.getByLabel("名称").fill(originalName);
    await createDrawer.getByLabel("来源类型").click();
    await page.getByRole("option", { name: "其他", exact: true }).click();
    await createDrawer.getByLabel("默认价类").click();
    await page.getByRole("option", { name: "结算价", exact: true }).click();
    await chooseOption(page, createDrawer, "币种", currency.name);
    await chooseOption(page, createDrawer, "计量单位", unit.name);

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/base/market-instruments",
    );
    await createDrawer
      .getByRole("button", { name: "保存", exact: true })
      .click();
    const createResponse = await createResponsePromise;
    const createText = await createResponse.text();
    expect(
      createResponse.ok(),
      `${createResponse.status()} ${createText}`,
    ).toBeTruthy();
    createdId = (JSON.parse(createText) as { id: string }).id;
    await expect(createDrawer).toBeHidden();

    const instrumentSearch = page.getByRole("searchbox", { name: "搜索" });
    await instrumentSearch.fill(code);
    let row = page.getByRole("row").filter({ hasText: code });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
    const editDrawer = page.getByRole("dialog", { name: "编辑行情品种" });
    await editDrawer.getByLabel("名称").fill(updatedName);
    const editResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname ===
          `/api/v1/base/market-instruments/${createdId}`,
    );
    await editDrawer.getByRole("button", { name: "保存", exact: true }).click();
    const editResponse = await editResponsePromise;
    expect(
      editResponse.ok(),
      `${editResponse.status()} ${await editResponse.text()}`,
    ).toBeTruthy();
    await expect(editDrawer).toBeHidden();
    row = page.getByRole("row").filter({ hasText: updatedName });
    await expect(row).toBeVisible();

    await expect
      .poll(() =>
        restRequests.includes(
          "GET /api/v1/base/market-price-points/chart-instruments",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        restRequests.includes(
          "POST /api/v1/base/market-price-points/price-series",
        ),
      )
      .toBe(true);

    await page.getByRole("tab", { name: "价点明细", exact: true }).click();
    const priceGrid = page.getByRole("grid", {
      name: "basMarketPricePoints 数据表格",
    });
    await expect(priceGrid).toBeVisible();
    await page.getByRole("button", { name: "新增", exact: true }).click();
    const priceDrawer = page.getByRole("dialog", { name: "新增行情价点" });
    await expect(priceDrawer).toBeVisible();
    const selectorQueriesBefore = restRequests.filter(
      (entry) => entry === "POST /api/v1/base/market-instruments/query",
    ).length;
    const instrumentPicker = priceDrawer
      .getByRole("group")
      .filter({ hasText: "请选择…" })
      .first();
    await expect(instrumentPicker).toHaveCount(1, { timeout: 5_000 });
    await instrumentPicker.scrollIntoViewIfNeeded();
    await instrumentPicker.click();
    await expect(page.getByRole("listbox", { name: "选项" })).toBeVisible();
    await expect
      .poll(
        () =>
          restRequests.filter(
            (entry) => entry === "POST /api/v1/base/market-instruments/query",
          ).length,
      )
      .toBeGreaterThan(selectorQueriesBefore);
    await page.keyboard.press("Escape");
    await priceDrawer
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(priceDrawer).toBeHidden();

    const filterQueriesBefore = restRequests.filter(
      (entry) => entry === "POST /api/v1/base/market-instruments/query",
    ).length;
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page
      .getByRole("listbox", { name: "可筛选字段" })
      .getByRole("option", { name: "行情品种", exact: true })
      .click();
    const filterDialog = page.getByRole("dialog", { name: "行情品种" });
    await expect(filterDialog).toBeVisible();
    const filterPicker = filterDialog.getByRole("group");
    await expect(filterPicker).toHaveCount(1);
    await filterPicker.click();
    await expect(page.getByRole("listbox").last()).toBeVisible();
    await page.getByRole("searchbox", { name: "搜索" }).last().fill(code);
    await expect
      .poll(
        () =>
          restRequests.filter(
            (entry) => entry === "POST /api/v1/base/market-instruments/query",
          ).length,
      )
      .toBeGreaterThan(filterQueriesBefore);
    await expect(
      page.getByRole("option", { name: updatedName, exact: true }),
    ).toBeVisible();

    await page.goto("/base/market");
    await expect(
      page.getByRole("heading", { name: "行情", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "品种维护", exact: true }).click();
    await instrumentSearch.fill(code);
    row = page.getByRole("row").filter({ hasText: updatedName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "确认删除" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.getByText("删除成功(1 条)")).toBeVisible();
    await expect(row).toBeHidden();

    expect(restRequests).toEqual(
      expect.arrayContaining([
        "GET /api/v1/meta/resources/basMarketPricePoints",
        "GET /api/v1/meta/resources/basMarketInstruments",
        "POST /api/v1/base/market-price-points/query",
        "POST /api/v1/base/market-instruments/query",
        "GET /api/v1/base/market-price-points/chart-instruments",
        "POST /api/v1/base/market-price-points/price-series",
        "POST /api/v1/base/market-instruments",
        `PATCH /api/v1/base/market-instruments/${createdId}`,
        `DELETE /api/v1/base/market-instruments/${createdId}`,
        "POST /api/v1/base/currencies/query",
        "POST /api/v1/base/units/query",
      ]),
    );
    expect(graphqlRequests).toEqual([]);
  } finally {
    if (createdId) {
      await cleanupInstrument(cookie, createdId);
    }
  }
});
